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
const fake=()=>({getAccount:async()=>({equity:10000,lastEquity:10000,cash:5000,buyingPower:5000}),getClock:async()=>({isOpen:true}),getPositions:async()=>[],getOrderByClientId:async()=>null});
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
 assert.equal(r.status,200);const data=await r.json();assert.equal(data.account.equity,10000);assert.equal(data.dryRun,true);
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
 await worker('entry',{client:{...client,getPositions:async()=>[{symbol:Object.values(read('journal.json').orders)[0].ticker,qty:1}]},now,wallClock:()=>now});
 assert.equal(submissions,1);process.env.DRY_RUN='true';
});
