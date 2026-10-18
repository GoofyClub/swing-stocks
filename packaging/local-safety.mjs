import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {read,write,dataDir} from './local-store.mjs';
import {flattenOrders,isWorking,dateET} from './local-risk.mjs';
import {brokerPrice} from '../src/auto/engine.js';
const terminal=o=>['filled','canceled','cancelled','rejected','expired','replaced','done_for_day'].includes(o.status);
const sellMarket=o=>o.side==='sell'&&o.type==='market'&&!terminal(o);
const stopCoverage=(orders,symbol)=>flattenOrders(orders).filter(o=>o.symbol===symbol&&o.side==='sell'&&['stop','trailing_stop'].includes(o.type)&&['new','accepted','held','pending_new','partially_filled','accepted_for_bidding'].includes(o.status)&&isWorking(o)&&!(o.status==='held'&&flattenOrders(orders).some(p=>p.symbol===symbol&&p.side==='buy'&&!terminal(p)&&Number(p.filled_qty||0)<Number(p.qty)))).reduce((n,o)=>n+Math.max(0,Number(o.qty)-Number(o.filled_qty||0)),0);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function queueAlert(text,now=new Date()){
  const dir=path.join(dataDir,'alerts');fs.mkdirSync(dir,{recursive:true});
  const id=crypto.createHash('sha256').update(text+Math.floor(now.getTime()/1800000)).digest('hex').slice(0,24);
  const file=path.join(dir,id+'.json');
  try{fs.writeFileSync(file,JSON.stringify({text,createdAt:now.toISOString(),sent:[]}),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
}
export async function flushAlerts(send,chatIds){
  const dir=path.join(dataDir,'alerts');let files;try{files=fs.readdirSync(dir);}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const name of files.filter(f=>/^[a-f0-9]{24}\.json$/.test(f))){
    const file=path.join(dir,name),alert=JSON.parse(fs.readFileSync(file,'utf8'));
    if(Date.now()-Date.parse(alert.createdAt)>7*86400000&&chatIds.every(id=>alert.sent.includes(id))){fs.unlinkSync(file);continue;}
    for(const id of chatIds){if(alert.sent.includes(id))continue;await send(id,alert.text+'\nRecorded: '+alert.createdAt+' — use /safety for current status.');alert.sent.push(id);const tmp=file+'.bot.tmp';fs.writeFileSync(tmp,JSON.stringify(alert),{mode:0o600});fs.renameSync(tmp,file);}
  }
}
// Persisted separately from the trade journal, so cancel/submit crash recovery
// cannot be overwritten by the existing journal adapter's reconciliation saves.
export async function recoverExit({client,symbol,reason='managed exit',stopPrice,now=new Date(),dryRun=false,pause=sleep}){
  const all=read('exits.json',{});let intent=all[symbol];
  if(!intent||intent.phase==='closed'){
    intent={symbol,reason,stopPrice,phase:'intent',attempt:0,key:'sx.'+crypto.randomUUID().replace(/-/g,''),createdAt:now.toISOString()};
    if(!dryRun){all[symbol]=intent;write('exits.json',all);}
  }
  const save=()=>{intent.updatedAt=now.toISOString();write('exits.json',all);};
  const position=async()=> (await client.getPositions()).find(p=>p.symbol===symbol&&Number(p.qty)>0);
  async function confirmFlat(){
    // A restored GTC sell stop must not survive a late liquidation fill and
    // accidentally become a new short. Clean remaining symbol reservations.
    intent.phase='flat_cleanup';save();
    for(const order of flattenOrders(await client.getOpenOrders(symbol)).filter(o=>o.symbol===symbol&&!terminal(o))){
      if(order.status==='pending_cancel')continue;
      try{await client.cancelOrder(order.id);}catch(e){if(![404,422].includes(e.status))throw e;}
    }
    const remaining=flattenOrders(await client.getOpenOrders(symbol)).filter(o=>o.symbol===symbol&&!terminal(o));
    if(remaining.length||await position())return {pending:true};
    intent.phase='closed';save();return {flat:true,id:intent.brokerOrderId||null};
  }
  if(dryRun)return {pending:true,dryRun:true};
  let lastError=null;
  for(let pass=0;pass<3;pass++){
    try{
      let pos=await position();
      if(!pos)return await confirmFlat();
      let orders=flattenOrders(await client.getOpenOrders(symbol));
      if(!(intent.stopPrice>0)){const stop=orders.find(o=>o.symbol===symbol&&o.side==='sell'&&o.type==='stop'&&Number(o.stop_price)>0);if(stop){intent.stopPrice=Number(stop.stop_price);save();}}
      const working=orders.find(o=>o.symbol===symbol&&sellMarket(o));
      if(working){intent.phase='working';intent.brokerOrderId=working.id;save();return {id:working.id,pending:true};}
      const coid=intent.key+'.'+intent.attempt;
      const accepted=await client.getOrderByClientId(coid);
      if(accepted&&!terminal(accepted)){intent.phase='working';intent.brokerOrderId=accepted.id;save();return {id:accepted.id,pending:true};}
      if(accepted?.status==='filled'&&Number(accepted.filled_qty)>=Number(intent.qty||Infinity)){
        intent.phase='reconcile_required';save();queueAlert(`RSI2 ${symbol}: exit reports filled but shares remain. New entries blocked; inspect broker before another sale.`,now);return {id:accepted.id,pending:true};
      }
      if(accepted){
        // Never overlap replacement exits: the previous attempt must be terminal.
        intent.attempt++;intent.brokerOrderId=null;intent.phase='intent';save();
        pos=await position();if(!pos)return await confirmFlat();
      }
      if(!(await client.getClock()).isOpen){
        if(stopCoverage(orders,symbol)<Number(pos.qty)){
          if(orders.some(o=>o.symbol===symbol&&!terminal(o)))throw Error('Cannot restore protection while reservations remain');
          const stop=brokerPrice(Number(intent.stopPrice));if(!(stop>0))throw Error('No known stop for closed session');
          const id=intent.key+'.s'+intent.attempt,known=await client.getOrderByClientId(id);
          const restored=known||await client.submitProtectiveStop(symbol,Number(pos.qty),stop,id);
          if(!restored?.id||terminal(restored))throw Error('Closed-session stop not accepted');
          intent.restoredStopId=restored.id;
        }
        intent.phase='waiting_market';save();return {pending:true};
      }
      intent.phase='canceling';save();
      for(const o of orders.filter(o=>o.symbol===symbol&&!terminal(o))){
        if(o.status==='pending_cancel')continue;
        try{await client.cancelOrder(o.id);}catch(e){if(![404,422].includes(e.status))throw e;}
      }
      // Bracket/OCO cancellations are asynchronous. Poll; do not race reservations.
      for(let poll=0;poll<5;poll++){
        orders=flattenOrders(await client.getOpenOrders(symbol)).filter(o=>o.symbol===symbol&&!terminal(o));
        const market=orders.find(sellMarket);
        if(market){intent.phase='working';intent.brokerOrderId=market.id;save();return {id:market.id,pending:true};}
        if(!orders.length)break;
        await pause(200);
      }
      if(orders.length)throw Error('Reservations not released');
      pos=await position();if(!pos)return await confirmFlat();
      // A timeout is retried with this SAME ID. Advance only after broker-terminal
      // evidence above; losing an acknowledgement must not create a second sale.
      intent.phase='submitting';intent.qty=Number(pos.qty);save();
      const exit=await client.submitMarketExit(symbol,intent.qty,intent.key+'.'+intent.attempt);
      if(!exit?.id||['rejected','canceled','expired'].includes(exit.status))throw Error('Liquidation not accepted');
      intent.phase='working';intent.brokerOrderId=exit.id;save();return {id:exit.id,pending:true};
    }catch(e){lastError=e;intent.phase='uncertain';save();if(pass<2)await pause(250);}
  }
  // Last-resort protection. Read broker state AGAIN before restoring a stop;
  // a lost acknowledgement can mean the liquidation is already working.
  try{
    const pos=await position();
    if(!pos)return await confirmFlat();
    const accepted=await client.getOrderByClientId(intent.key+'.'+intent.attempt);
    const orders=flattenOrders(await client.getOpenOrders(symbol));
    const working=orders.find(o=>o.symbol===symbol&&sellMarket(o));
    if(working||(accepted&&!terminal(accepted))){const o=working||accepted;intent.phase='working';intent.brokerOrderId=o.id;save();return {id:o.id,pending:true};}
    if(Math.abs(stopCoverage(orders,symbol)-Number(pos.qty))<1e-8){intent.phase='protected_retry';save();}
    else{
      if(orders.some(o=>o.symbol===symbol&&!terminal(o)))throw Error('Orders still reserve shares');
      const stop=brokerPrice(Number(intent.stopPrice));
      if(!(stop>0))throw Error('No known protective stop');
      // Stable per exit attempt, including recovery after a lost stop ack.
      const id=intent.key+'.s'+intent.attempt;
      const existing=await client.getOrderByClientId(id);
      if(existing&&terminal(existing))throw Error('Protective stop terminal; reconcile before replacing');
      const restored=existing||await client.submitProtectiveStop(symbol,Number(pos.qty),stop,id);
      if(!restored?.id||terminal(restored))throw Error('Protective stop not accepted');
      intent.restoredStopId=restored.id;intent.phase='protected_retry';save();
    }
  }catch{intent.phase='unprotected';save();}
  queueAlert(`RSI2 EXIT NEEDS ATTENTION: ${symbol}. Liquidation could not be confirmed. ${intent.phase==='protected_retry'?'A protective stop is recorded; exit retry remains pending.':'Protection could not be confirmed; inspect Alpaca immediately.'} New entries are blocked.`,now);
  return {pending:true,failed:true,protected:intent.phase==='protected_retry',error:lastError?.name||'Error'};
}
export async function auditSafety({client,journal,now=new Date(),dryRun=false,pause=sleep}){
  let positions,orders;const issues=[];
  try{positions=await client.getPositions();orders=flattenOrders(await client.getOpenOrders());}
  catch{issues.push('Cannot verify broker positions/protection');return finish();}
  for(const order of orders){
    if(order.side==='sell'&&!terminal(order)&&!positions.some(p=>p.symbol===order.symbol)&&!orders.some(b=>b.symbol===order.symbol&&b.side==='buy'&&!terminal(b)))issues.push(`Orphan sell order ${order.symbol}; inspect broker`);
  }
  let calendar;
  if(positions.length){
    try{
      const today=dateET(now),cached=read('risk-calendar.json',{});
      if(cached.day===today)calendar=cached.days;
      else{calendar=await client.getCalendar(new Date(now.getTime()-90*86400000).toISOString().slice(0,10),today);write('risk-calendar.json',{day:today,days:calendar});}
      if(!Array.isArray(calendar)||!calendar.length)throw Error('Calendar empty');
    }catch{issues.push('Cannot verify holding ages against market calendar');}
  }
  for(const pos of positions){
    if(!(Number(pos.qty)>0)){issues.push(`Unexpected short holding ${pos.symbol}`);continue;}
    const active=read('exits.json',{})[pos.symbol];
    if(active&&active.phase!=='closed'){
      if(!dryRun)await recoverExit({client,symbol:pos.symbol,reason:active.reason,stopPrice:active.stopPrice,now,pause});
      issues.push(`${pos.symbol}: exit recovery pending verification`);continue;
    }
    const row=Object.values(journal).find(o=>o.ticker===pos.symbol&&['filled','partially_filled','submitted','exit_submitted'].includes(o.status));
    if(!row){issues.push(`Untracked holding ${pos.symbol}; review local journal`);continue;}
    const today=dateET(now),minute=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hourCycle:'h23',hour:'2-digit'}).format(now))*60+Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',minute:'2-digit'}).format(now));
    const sessions=calendar?.filter(day=>day.date>row.sessionDate&&(day.date<today||(day.date===today&&minute>=935))).length;
    const overdue=sessions>=7;
    if(!row.sessionDate)issues.push(`Missing entry session for ${pos.symbol}`);
    const pending=read('exits.json',{})[pos.symbol];
    if(overdue||Math.abs(stopCoverage(orders,pos.symbol)-Number(pos.qty))>1e-8||pending&&pending.phase!=='closed'){
      const reason=overdue?'seven-session time stop':pending?.reason||'missing or mismatched protective stop';
      if(!dryRun)await recoverExit({client,symbol:pos.symbol,reason,stopPrice:row.sl,now,dryRun,pause});
      issues.push(`${pos.symbol}: ${reason}; exit pending verification`);
    }
  }
  // Positions can disappear after protective fills; close their durable intents.
  for(const [symbol,intent] of Object.entries(read('exits.json',{}))){
    if(intent.phase==='closed'||positions.some(p=>p.symbol===symbol))continue;
    if(!dryRun)await recoverExit({client,symbol,now,pause});
  }
  // Refresh after recovery to avoid relying on the pre-cancel snapshot.
  try{positions=await client.getPositions();orders=flattenOrders(await client.getOpenOrders());}catch{issues.push('Post-recovery broker snapshot unavailable');}
  return finish();
  function finish(){
    const unresolved=Object.values(read('exits.json',{})).filter(i=>i.phase!=='closed').map(i=>`${i.symbol}: ${i.phase}`);
    const reasons=[...new Set([...issues,...unresolved])];
    const status={...read('safety.json',{}),at:now.toISOString(),blocked:reasons.length>0,issues:reasons,exits:read('exits.json',{}),dryRun};write('safety.json',status);
    if(status.blocked)queueAlert('RSI2 SAFETY: '+reasons.join('; ')+'. New entries blocked; exits keep running.',now);
    return {...status,positions:positions||[],orders:orders||[]};
  }
}
