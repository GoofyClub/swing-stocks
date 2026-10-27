import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rsi2-local-'));
process.env.SWING_DATA_DIR=temp;
process.env.ALPACA_KEY='fixture';process.env.ALPACA_SECRET='fixture';
const {read,write,localStore}=await import('../packaging/local-store.mjs');
const {worker}=await import('../packaging/local-worker.mjs');
const {command,authorized}=await import('../packaging/local-bot.mjs');
const {server}=await import('../packaging/local-dashboard.mjs');
after(()=>fs.rmSync(temp,{recursive:true,force:true}));
const fake=()=>({getAccount:async()=>({equity:10000,lastEquity:10000,cash:5000,buyingPower:5000}),getClock:async()=>({isOpen:true}),getPositions:async()=>[],getOrderByClientId:async()=>null,getOpenOrders:async()=>[],getCalendar:async()=>[]});
test('local adapter persists journal updates used by existing reconciliation',async()=>{
 write('journal.json',{orders:{a:{status:'submitted',createdAt:new Date().toISOString()}},peakEquity:0});
 const {db}=localStore();const q=db.collection('users').doc('local').collection('autoOrders');
 const rows=await q.where('status','in',['submitted']).where('createdAt','>=',new Date(Date.now()-1000)).get();
 assert.equal(rows.docs.length,1);await rows.docs[0].ref.update({status:'filled'});assert.equal(read('journal.json').orders.a.status,'filled');
});
test('paused dry-run does not submit, cancel or close orders',async()=>{
 write('journal.json',{orders:{},peakEquity:0});write('control.json',{paused:true});process.env.DRY_RUN='true';
 const client={...fake(),submitBracketOrder:()=>assert.fail('entry'),closePosition:()=>assert.fail('exit'),cancelOrder:()=>assert.fail('cancel')};
 await worker('entry',{client});await worker('flatten',{client});assert.equal(read('journal.json').peakEquity,10000);
});
test('accepted submission is recovered before reconciliation',async()=>{
 write('journal.json',{orders:{a:{ticker:'AAPL',status:'pending_submit',clientOrderId:'a'}},peakEquity:0});
 await worker('maintenance',{client:{...fake(),getOrderByClientId:async()=>({id:'broker-a'}),getOrder:async()=>({status:'filled',filled_qty:'2',filled_avg_price:'100'})}});
 const row=read('journal.json').orders.a;assert.equal(row.brokerOrderId,'broker-a');assert.equal(row.status,'filled');assert.equal(row.filledQty,2);
});
test('Telegram restricts chats, pause persists and destructive actions require CONFIRM',async()=>{
 process.env.TELEGRAM_ALLOWED_CHAT_IDS='123,456';assert.equal(authorized(123),true);assert.equal(authorized(789),false);
 await command('/pause');assert.equal(read('control.json').paused,true);
 await command('/resume');assert.equal(read('control.json').paused,false);
 assert.match(await command('/flatten',{run:()=>assert.fail('must confirm')}),/CONFIRM/);
 assert.match(await command('/set riskPerTradePct 100'),/Invalid/);
 await command('/set riskPerTradePct 0.25');assert.equal(read('config.json').riskPerTradePct,.25);
});
test('dashboard requires authentication and returns broker data without cloud access',async()=>{
 process.env.DASHBOARD_USER='tester';process.env.DASHBOARD_PASSWORD_HASH=crypto.createHash('sha256').update('long-fixture-password').digest('hex');
 const app=server({client:fake()});await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
 try{const url=`http://127.0.0.1:${app.address().port}`;assert.equal((await fetch(url)).status,401);
 const r=await fetch(url+'/api/summary',{headers:{Authorization:'Basic '+Buffer.from('tester:long-fixture-password').toString('base64')}});
 assert.equal(r.status,200);const data=await r.json();assert.equal(data.account.equity,10000);assert.equal(data.dryRun,true);assert.equal(data.settings.maxGrossExposurePct,100);assert.equal(data.eventCoverage.required,false);
 }finally{await new Promise(resolve=>app.close(resolve));}
});
test('valid RSI2 entry is protected and repeated passes cannot duplicate it',async()=>{
 process.env.DRY_RUN='false';process.env.WATCHLIST_SET='core';
 write('journal.json',{orders:{},peakEquity:0});write('control.json',{paused:false});
 write('config.json',{respectRegime:false,tiers:[],maxConcurrentPositions:1});
 const now=new Date('2026-10-15T19:42:00Z');
 const bars=Array.from({length:250},(_,i)=>{const close=i<245?100+i*.25:161-(i-244)*1.1;return {date:new Date(now.getTime()-(249-i)*86400000).toISOString().slice(0,10),open:close+.1,close,high:close+.4,low:close-.4,volume:3000000};});
 let submissions=0,intent;
 const client={...fake(),getDailyBars:async()=>bars,getLatestPrice:async()=>155.5,
  submitBracketOrder:async order=>{submissions++;intent=order;return {id:'order-1'};},
  getOrder:async()=>({status:'new',filled_qty:'0'})};
 await worker('entry',{client,now,wallClock:()=>now});
 assert.equal(submissions,1);assert.ok(intent.stopLoss.stopPrice<155.5);assert.ok(intent.takeProfit.limitPrice>155.5);
 assert.equal(Object.values(read('journal.json').orders)[0].brokerOrderId,'order-1');
 await worker('entry',{client:{...client,getOpenOrders:async()=>[{id:'protect',symbol:'AAPL',side:'sell',type:'stop',status:'new',qty:'1',filled_qty:'0'}],getPositions:async()=>[{symbol:Object.values(read('journal.json').orders)[0].ticker,qty:1,avgEntry:155.5}]},now,wallClock:()=>now});
 assert.equal(submissions,1);process.env.DRY_RUN='true';
});
test('uncertain submission stops this scan and blocks the next until reconciled',async()=>{
 process.env.DRY_RUN='false';write('config.json',{respectRegime:false,tiers:[],requireEventCoverage:false});write('control.json',{paused:false});write('journal.json',{orders:{},peakEquity:0});
 const now=new Date('2026-10-15T19:42:00Z');
 const bars=Array.from({length:250},(_,i)=>{const close=i<245?100+i*.25:161-(i-244)*1.1;return {date:new Date(now.getTime()-(249-i)*86400000).toISOString().slice(0,10),open:close+.1,close,high:close+.4,low:close-.4,volume:3000000};});
 let attempts=0;
 const client={...fake(),getDailyBars:async()=>bars,getLatestPrice:async()=>155.5,submitBracketOrder:async()=>{attempts++;throw Error('network timeout after send');}};
 await worker('entry',{client,now,wallClock:()=>now});assert.equal(attempts,1);assert.equal(Object.values(read('journal.json').orders)[0].status,'pending_submit');
 await worker('entry',{client,now,wallClock:()=>now});assert.equal(attempts,1);process.env.DRY_RUN='true';
});
test('dashboard calendar counts only confirmed outcomes on New York recording date',async()=>{
 const {performanceHistory,equityHistory}=await import('../packaging/local-dashboard.mjs');
 const now=new Date('2026-10-18T01:00:00Z');
 const rows=[{ticker:'AAPL',realizedAt:'2026-10-17T01:00:00Z',realizedPnl:25,realizedSource:'bracket_fill',realizedExit:105,filledQty:5,filledAvgPrice:100},{ticker:'MSFT',realizedAt:'2026-10-16T20:00:00Z',realizedPnl:-10,realizedSource:'managed_exit_fill'},{ticker:'OLD',realizedAt:'2026-01-01T20:00:00Z',realizedPnl:1000,realizedSource:'bracket_fill'},{ticker:'MODEL',realizedAt:'2026-10-16T20:00:00Z',realizedPnl:999},{ticker:'BAD',realizedAt:'bad',realizedPnl:999,realizedSource:'bracket_fill'}];
 const history=performanceHistory(rows,now);assert.equal(history.days.length,1);assert.equal(history.days[0].date,'2026-10-16');assert.equal(history.days[0].pnl,15);assert.equal(history.days[0].count,2);assert.equal(history.days[0].trades[0].entry,100);
 const ts=Date.parse('2026-10-16T20:00:00Z')/1000;
 assert.deepEqual(equityHistory({timestamp:[ts,ts+86400,ts+2*86400,ts+3*86400],equity:[10000,0,null,-1]}).points,[{date:'2026-10-16',equity:10000},{date:'2026-10-17',equity:0}]);
});
test('dashboard serves authenticated assets and handles unavailable broker without invented values',async()=>{
 const client={getAccount:async()=>{throw Error('offline');},getPositions:async()=>[]};
 const app=server({client});await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${app.address().port}`,headers={Authorization:'Basic '+Buffer.from('tester:long-fixture-password').toString('base64')};
 try{
  assert.equal((await fetch(url+'/assets/dashboard.js')).status,401);
  for(const asset of ['dashboard.js','dashboard.css','performance.js']){const response=await fetch(url+'/assets/'+asset,{headers});assert.equal(response.status,200);assert.ok((await response.text()).length>100);}
  const response=await fetch(url+'/api/summary',{headers});const data=await response.json();assert.match(data.error,/unavailable/);assert.equal(data.account,undefined);assert.ok(data.balance.error);assert.equal(data.settings.apiSecret,undefined);assert.equal(data.settings.apiKey,undefined);
 }finally{await new Promise(resolve=>app.close(resolve));}
});
test('dashboard equity request uses the real broker adapter and preserves zero versus missing',async()=>{
 const {createAlpacaClient}=await import('../src/broker/alpaca.js');
 const {equityHistory}=await import('../packaging/local-dashboard.mjs');
 const stamp=Date.parse('2026-10-16T20:00:00Z')/1000;let request;
 const client=createAlpacaClient({baseUrl:'https://paper-api.alpaca.markets',apiKey:'fixture',apiSecret:'fixture',fetchImpl:async url=>{request=new URL(url);return new Response(JSON.stringify({timestamp:[stamp,stamp+86400,stamp+2*86400],equity:[10000,0,null]}),{status:200});}});
 const raw=await client.getPortfolioHistory({period:'3M',timeframe:'1D',raw:true});
 assert.equal(request.pathname,'/v2/account/portfolio/history');assert.equal(request.searchParams.get('period'),'3M');assert.equal(request.searchParams.get('raw'),null);
 assert.deepEqual(equityHistory(raw).points,[{date:'2026-10-16',equity:10000},{date:'2026-10-17',equity:0}]);
 const legacy=await client.getPortfolioHistory();assert.ok(Array.isArray(legacy.points));assert.equal(request.searchParams.get('period'),'1M');
});
test('entry scan reserves pending buys and caps a cross-sector correlated group',async()=>{
 process.env.DRY_RUN='false';process.env.WATCHLIST_SET='core';write('config.json',{respectRegime:false,tiers:[],requireEventCoverage:false,maxPositionsPerSector:20});write('control.json',{paused:false});write('journal.json',{orders:{},peakEquity:0});write('exits.json',{});
 const now=new Date('2026-10-15T19:42:00Z');
 const bars=Array.from({length:250},(_,i)=>{const close=i<245?100+i*.25:161-(i-244)*1.1;return {date:new Date(now.getTime()-(249-i)*86400000).toISOString().slice(0,10),open:close+.1,close,high:close+.4,low:close-.4,volume:3000000};});
 const open=[];let submitted=0;
 const client={...fake(),getAccount:async()=>({equity:10000,lastEquity:10000,cash:10000,buyingPower:100000}),getDailyBars:async()=>bars,getLatestPrice:async()=>155.5,getOpenOrders:async()=>open,submitBracketOrder:async intent=>{submitted++;const order={id:'buy-'+submitted,client_order_id:intent.clientOrderId,symbol:intent.symbol,qty:String(intent.qty),filled_qty:'0',side:'buy',type:'market',status:'new'};open.push(order);return order;}};
 await worker('entry',{client,now,wallClock:()=>now});
 assert.ok(submitted>=2);assert.ok(open.every(o=>Number(o.qty)*155.5<=2000));
 assert.ok(open.reduce((n,o)=>n+Number(o.qty)*155.5*1.01,0)<=4000);
 process.env.DRY_RUN='true';
});
test('opt-in verified earnings coverage blocks entry without sending orders',async()=>{
 process.env.DRY_RUN='false';write('config.json',{respectRegime:false,tiers:[],requireEventCoverage:true});write('control.json',{paused:false});write('journal.json',{orders:{},peakEquity:0});write('exits.json',{});write('events.json',{});
 const now=new Date('2026-10-15T19:42:00Z');
 await worker('entry',{client:{...fake(),getDailyBars:async()=>[],submitBracketOrder:()=>assert.fail('No coverage must not trade')},now,wallClock:()=>now});
 assert.ok(Object.keys(read('safety.json').entryBlocks).some(k=>k.includes('Earnings coverage')));
 assert.match(await command('/earnings AAPL none'),/coverage saved/);assert.ok(read('events.json').symbols.AAPL.checkedAt);
 assert.match(await command('/eventblock 2026-02-30'),/Usage/);process.env.DRY_RUN='true';
});
test('Telegram can opt out of mandatory coverage without disabling exposure or exit controls',async()=>{
 await command('/earningsfilter off');assert.equal(read('config.json').requireEventCoverage,false);
 const {config}=await import('../packaging/local-store.mjs');assert.equal(config().maxGrossExposurePct,100);assert.equal(config().maxPositionEquityPct,20);
 await command('/earningsfilter on');assert.equal(read('config.json').requireEventCoverage,true);
 assert.match(await command('/earningsfilter invalid'),/Usage/);
});

test('both health commands include the configured dashboard even when health fails',async()=>{
 const previous=process.env.DASHBOARD_URL;
 try{
  process.env.DASHBOARD_URL='https://fixture.tail.example:8444';
  for(const text of ['/health','/healthcheck']){
   const answer=await command(text,{client:fake(),run:async()=>({stdout:'Workers: running\n'})});
   assert.match(answer,/Workers: running/);assert.match(answer,/Dashboard: https:\/\/fixture.tail.example:8444/);
  }
  assert.match(await command('/health',{client:fake(),run:async()=>{throw new Error('fixture');}}),/Health check failed[\s\S]*Dashboard: https:/);
  delete process.env.DASHBOARD_URL;
  assert.match(await command('/health',{client:fake(),run:async()=>({stdout:'OK'})}),/127\.0\.0\.1:8444 \(on the bot PC/);
 }finally{if(previous===undefined)delete process.env.DASHBOARD_URL;else process.env.DASHBOARD_URL=previous;}
});

test('health reports persisted pause state for both aliases, including failed checks',async()=>{
 const run=async()=>({stdout:'Workers: running\n'});
 for(const text of ['/health','/healthcheck']){
  await command('/pause');
  const paused=await command(text,{client:fake(),run});
  assert.match(paused,/Entries: PAUSED/);assert.match(paused,/Send \/resume/);assert.match(paused,/DRY_RUN=true/);
  const failed=await command(text,{client:fake(),run:async()=>{throw new Error('fixture');}});
  assert.match(failed,/Entries: PAUSED/);
  await command('/resume');
  assert.match(await command(text,{client:fake(),run}),/Entries: enabled \(subject to schedule and safety filters\)/);
 }
});

test('Telegram diagnostics identify common failures without exposing error contents',async()=>{
 const {telegramFailure}=await import('../packaging/local-bot.mjs');
 assert.match(telegramFailure({telegramStatus:409}),/another bot instance/);
 assert.match(telegramFailure({telegramStatus:401}),/authentication failed/);
 assert.match(telegramFailure({cause:{code:'ENOTFOUND'}}),/ENOTFOUND/);
 assert.doesNotMatch(telegramFailure(new Error('secret-token-url')),/secret-token/);
});
