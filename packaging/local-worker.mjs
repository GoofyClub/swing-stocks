import '../scripts/lib/load-env.mjs';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { createAlpacaClient } from '../src/broker/alpaca.js';
import { STRATEGIES,tierReasons,advUsdFor } from '../src/strategy/normalize.js';
import { regimeCheck } from '../src/strategy/engine.js';
import { STARTER_WATCHLIST,LARGE_CAP_TICKERS } from '../src/data/markets.js';
import { clientOrderId,sizePosition,signalMatchesRules,passesPortfolioGuards,drawdownHalted,marketClock,inCloseWindow,stopClearanceOk,slippageOk,buildBracketOrder,inReentryCooldown,regimeAllowsEntry,isTradeDayAllowed,placedStopPrice } from '../src/auto/engine.js';
import { manageExits } from '../scripts/lib/exit-pass.mjs';
import { reconcileOrders } from '../scripts/lib/reconcile.mjs';
import { realizeOutcomes } from '../scripts/lib/realize.mjs';
import { attachFileLog } from '../scripts/lib/logfile.mjs';
import { localStore,config,read,write } from './local-store.mjs';

export function broker(){
  const raw=createAlpacaClient({baseUrl:'https://paper-api.alpaca.markets',apiKey:process.env.ALPACA_KEY,apiSecret:process.env.ALPACA_SECRET,fetchImpl:(url,options={})=>fetch(url,{...options,signal:AbortSignal.timeout(20000)})});
  let lastBars=0;
  return {...raw,getDailyBars:async(symbol,opts={})=>{
    // Stay below the free data plan's 200 requests/minute.
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,340-(Date.now()-lastBars))));
    lastBars=Date.now();return raw.getDailyBars(symbol,{...opts,feed:'iex'});
  }};
}
export const dryRun=()=>process.env.DRY_RUN!=='false';
export async function worker(mode='maintenance',{client=broker(),now=new Date(),wallClock=()=>new Date()}={}){
  const store=localStore(),{state,db,admin,save}=store,cfg=config();
  const log=message=>console.log(`[local-rsi2] ${message}`);
  const account=await client.getAccount();
  const dd=drawdownHalted({equity:account.equity,peakEquity:state.peakEquity,maxDrawdownHaltPct:cfg.maxDrawdownHaltPct});
  state.peakEquity=dd.peak;save();
  if(mode==='flatten'){
    if(dryRun()){log('DRY RUN: flatten skipped');return;}
    for(const p of await client.getPositions())await client.closePosition(p.symbol,{cancelOrders:true});
    log('Flatten requests submitted; verify /positions until flat');return;
  }
  // Reconcile the known broker IDs before evaluating managed exits. Alpaca's
  // calendar/clock determines whether stale entries can still be working today.
  const clock=await client.getClock();
  for(const row of Object.values(state.orders)){
    if(row.status!=='pending_submit')continue;
    const order=await client.getOrderByClientId(row.clientOrderId);
    if(order){row.brokerOrderId=order.id;row.status='submitted';save();}
    else log(`Unconfirmed submission ${row.ticker}: no broker match; entries blocked until reviewed`);
  }
  // Rebuild the adapter so recovered submissions are included in queries.
  const recovered=localStore();
  await reconcileOrders({db:recovered.db,admin,uid:'local',client,log,currentSession:!dryRun()&&clock.isOpen?marketClock(now).date:null});
  await manageExits({db:recovered.db,admin,uid:'local',client,log,dryRun:dryRun()});
  await realizeOutcomes({db:recovered.db,admin,uid:'local',client,log});
  Object.assign(state,recovered.state);
  if(mode!=='entry'||Object.values(state.orders).some(o=>o.status==='pending_submit')||!isTradeDayAllowed(cfg,now)||read('control.json',{paused:true}).paused||dd.halted||!clock.isOpen||!inCloseWindow(now)){
    log(`Entries skipped: mode=${mode}, paused=${read('control.json',{paused:true}).paused}, drawdownHalt=${dd.halted}`);return;
  }
  const start=new Date(now.getTime()-550*86400000).toISOString().slice(0,10);
  const today=marketClock(now).date;
  const indexBars=await client.getDailyBars('SPY',{start,limit:1000});
  if(cfg.respectRegime&&!regimeAllowsEntry(regimeCheck(indexBars,null,null,{indexLabel:'SPY'})).ok){log('Risk-off regime; no new longs');return;}
  const universe=JSON.parse(fs.readFileSync(new URL('../src/data/universe.json',import.meta.url),'utf8'));
  const list=process.env.WATCHLIST_SET==='broad'?Object.entries(universe).map(([t,v])=>({t,s:v.s||v.sector,index:v.index})):STARTER_WATCHLIST;
  let positions=await client.getPositions(), buyingPower=account.buyingPower;
  const held=new Set(positions.map(p=>p.symbol));
  for(const row of Object.values(state.orders)){
    if(['submitted','partially_filled'].includes(row.status)&&!held.has(row.ticker)){
      held.add(row.ticker);positions.push({symbol:row.ticker});
    }
  }
  let placed=0,scanned=0,failed=0;
  for(const item of list){
    if(!inCloseWindow(wallClock())||read('control.json',{paused:true}).paused){log('Entry window ended; remaining scan deferred');break;}
    scanned++;
    if(held.has(item.t)||cfg.excludeTickers.includes(item.t))continue;
    let bars;
    try{bars=await client.getDailyBars(item.t,{start,limit:1000});}catch{failed++;continue;}
    if(!bars.length||bars.at(-1).date!==today)continue;
    const result=STRATEGIES.rsi2.evaluate(bars);if(!result?.envelope)continue;
    const e=result.envelope,{tier}=tierReasons('rsi2',result.raw);
    const signal={ticker:item.t,market:'US',strategyKey:'rsi2',tier,side:'buy',entryPrice:e.entry,tpPrice:e.tp,slPrice:e.sl,sector:item.s,index:item.index||universe[item.t]?.index,largeCap:LARGE_CAP_TICKERS.has(item.t),advUsd:advUsdFor(bars)};
    if(!signalMatchesRules(signal,cfg).ok)continue;
    const losses=Object.values(state.orders).filter(o=>o.realizedWinLoss==='loss').map(o=>({ticker:o.ticker,exitedAt:o.realizedAt}));
    if(inReentryCooldown(item.t,losses,now).blocked)continue;
    const id=clientOrderId('local-rsi2',`${item.t}_rsi2_${today}`);
    if(state.orders[id]||await client.getOrderByClientId(id))continue;
    signal.slPrice=placedStopPrice(signal);
    const live=await client.getLatestPrice(item.t);
    if(!Number.isFinite(live)||!slippageOk(cfg,e.entry,live)||!stopClearanceOk(signal,live))continue;
    const sectorCount=positions.filter(p=>(universe[p.symbol]?.s||universe[p.symbol]?.sector)===item.s).length;
    if(!passesPortfolioGuards({cfg,openCount:held.size,sectorCount,openHeatPct:held.size*cfg.riskPerTradePct,addedHeatPct:cfg.riskPerTradePct,dayRealizedPct:account.lastEquity>0?(account.equity-account.lastEquity)/account.lastEquity*100:0}).ok)continue;
    const size=sizePosition({equity:account.equity,...cfg,entry:live,sl:signal.slPrice});
    if(size.shares<1||size.notional>buyingPower)continue;
    const row={ticker:item.t,side:'buy',strategyKey:'rsi2',entry:live,tp:e.tp,sl:signal.slPrice,qty:size.shares,sessionDate:today,createdAt:now.toISOString(),status:'submitted'};
    if(dryRun()){log(`DRY RUN would buy ${size.shares} ${item.t} with TP ${e.tp}, SL ${e.sl}`);continue;}
    // Persist intent before the broker call. Deterministic IDs recover an
    // accepted order if the process dies before its broker id can be saved.
    if(read('control.json',{paused:true}).paused||!inCloseWindow(wallClock())||!(await client.getClock()).isOpen)break;
    state.orders[id]={...row,status:'pending_submit',clientOrderId:id};save();
    try{
      const order=await client.submitBracketOrder(buildBracketOrder({signal,shares:size.shares,clientOrderId:id,entryType:'market'}));
      state.orders[id]={...row,brokerOrderId:order.id,clientOrderId:id};save();
      placed++;held.add(item.t);positions.push({symbol:item.t});buyingPower-=size.notional;
      log(`PLACED ${item.t} x${size.shares}`);
    }catch(error){state.orders[id].error=String(error.message);save();log(`Submission uncertain for ${item.t}; deterministic ID retained for reconciliation`);}
  }
  log(`Scan complete: ${scanned} examined, ${failed} data failures, ${placed} orders submitted`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  attachFileLog('local');worker(process.argv[2]).catch(e=>{console.error(`[local-rsi2] ${e.message}`);process.exit(1);});
}
