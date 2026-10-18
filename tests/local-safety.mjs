import {test,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rsi2-safety-'));process.env.SWING_DATA_DIR=dir;
const {read,write}=await import('../packaging/local-store.mjs');
const {recoverExit,auditSafety,queueAlert,flushAlerts}=await import('../packaging/local-safety.mjs');
const {LOCAL_DEFAULTS,portfolioExposure,allocationBudget,correlation,eventGate}=await import('../packaging/local-risk.mjs');
const now=new Date('2026-10-15T19:42:00Z'),pause=async()=>{};
beforeEach(()=>{for(const name of fs.readdirSync(dir))fs.rmSync(path.join(dir,name),{recursive:true,force:true});});
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
function broker(){
 const state={position:{symbol:'AAA',qty:10,avgEntry:100,marketValue:1000},orders:[{id:'stop',symbol:'AAA',type:'stop',side:'sell',status:'new',qty:'10',stop_price:'95'}],byClient:new Map(),sales:[],stops:[],open:true};
 const client={getPositions:async()=>state.position?[{...state.position}]:[],getOpenOrders:async()=>state.orders,getClock:async()=>({isOpen:state.open}),getCalendar:async()=>[],
  getOrderByClientId:async id=>state.byClient.get(id)||null,cancelOrder:async id=>{state.orders=state.orders.filter(o=>o.id!==id);},
  submitMarketExit:async(symbol,qty,id)=>{state.sales.push({symbol,qty,id});const o={id:'sell-'+state.sales.length,symbol,type:'market',side:'sell',status:'new',qty:String(qty),client_order_id:id};state.orders.push(o);state.byClient.set(id,o);return o;},
  submitProtectiveStop:async(symbol,qty,stop,id)=>{state.stops.push({symbol,qty,stop,id});const o={id:'restored',symbol,side:'sell',type:'stop',status:'new',qty:String(qty),stop_price:String(stop)};state.orders.push(o);state.byClient.set(id,o);return o;},
 };
 return {state,client,args:{client,symbol:'AAA',stopPrice:95,now,pause}};
}
test('exit intent persists before cancel; lost sale acknowledgement cannot duplicate liquidation after restart',async()=>{
 const {client,state,args}=broker(),submit=client.submitMarketExit;
 client.cancelOrder=async id=>{assert.ok(read('exits.json').AAA.key);state.orders=state.orders.filter(o=>o.id!==id);};
 client.submitMarketExit=async(...params)=>{await submit(...params);throw Error('lost response');};
 const first=await recoverExit(args);assert.equal(first.id,'sell-1');assert.equal(state.sales.length,1);
 await recoverExit({...args});assert.equal(state.sales.length,1);assert.equal(state.stops.length,0);
 state.position=null;state.orders=[];await recoverExit(args);assert.equal(read('exits.json').AAA.phase,'closed');
});
test('rejected exits retry with stable ID then restore protection and block entries',async()=>{
 const {client,state,args}=broker();const ids=[];
 client.submitMarketExit=async(s,q,id)=>{ids.push(id);throw Error('rejected');};
 const result=await recoverExit(args);assert.equal(ids.length,3);assert.equal(new Set(ids).size,1);assert.equal(result.protected,true);assert.equal(state.stops.length,1);assert.equal(read('exits.json').AAA.phase,'protected_retry');
 const safety=await auditSafety({client,journal:{a:{ticker:'AAA',status:'filled',sl:95,sessionDate:'2026-10-14'}},now,pause});
 assert.equal(safety.blocked,true);assert.ok(fs.readdirSync(path.join(dir,'alerts')).length>0);
});
test('pending cancellation prevents selling and restoring a competing stop',async()=>{
 const {client,state,args}=broker();client.cancelOrder=async()=>{state.orders[0].status='pending_cancel';};
 await recoverExit(args);assert.equal(state.sales.length,0);assert.equal(state.stops.length,0);assert.equal(read('exits.json').AAA.phase,'unprotected');
});
test('closed market retains existing protection and queues durable exit',async()=>{
 const {state,args}=broker();state.open=false;await recoverExit(args);assert.equal(state.orders[0].id,'stop');assert.equal(state.sales.length,0);assert.equal(read('exits.json').AAA.phase,'waiting_market');
});
test('closed market can restore a missing protective stop without liquidating',async()=>{
 const {state,args}=broker();state.open=false;state.orders=[];await recoverExit(args);assert.equal(state.stops.length,1);assert.equal(state.sales.length,0);assert.equal(read('exits.json').AAA.phase,'waiting_market');
});
test('canceled partial exit retries only the residual broker quantity',async()=>{
 const {state,args}=broker();const first=await recoverExit(args);state.orders=[];state.position.qty=4;const stored=state.byClient.values().next().value;stored.status='canceled';stored.filled_qty='6';
 await recoverExit(args);assert.equal(state.sales.length,2);assert.equal(state.sales[1].qty,4);assert.notEqual(state.sales[0].id,state.sales[1].id);
});
test('a filled exit with residual holdings requires reconciliation before another sale',async()=>{
 const {state,args}=broker();await recoverExit(args);state.orders=[];const order=state.byClient.values().next().value;order.status='filled';order.filled_qty='10';
 await recoverExit(args);assert.equal(state.sales.length,1);assert.equal(read('exits.json').AAA.phase,'reconcile_required');
});
test('audit closes tracked missing-stop positions, flags unknown holdings, and never mutates broker in dry-run',async()=>{
 const {state,client}=broker();state.orders=[];
 const journal={a:{ticker:'AAA',status:'filled',sl:95,sessionDate:'2026-10-14'}};
 const dry=await auditSafety({client,journal,now,dryRun:true,pause});assert.equal(dry.blocked,true);assert.equal(state.sales.length,0);assert.equal(read('exits.json',null),null);
 const active=await auditSafety({client,journal,now,pause});assert.equal(active.blocked,true);assert.equal(state.sales.length,1);
 write('exits.json',{});
 const unknown=await auditSafety({client,journal:{},now,pause});assert.ok(unknown.issues.some(x=>x.includes('Untracked')));assert.equal(state.sales.length,1);
});
test('overdue holding exits regardless of historical TP/SL touches or current protection',async()=>{
 const {state,client}=broker();client.getCalendar=async()=>Array.from({length:10},(_,i)=>({date:'2026-10-'+String(i+1).padStart(2,'0')}));
 const result=await auditSafety({client,journal:{a:{ticker:'AAA',status:'filled',sl:95,sessionDate:'2026-10-01'}},now,pause});assert.equal(result.blocked,true);assert.equal(state.sales.length,1);assert.equal(read('exits.json').AAA.reason,'seven-session time stop');
});
test('alert delivery is durable, deduplicated and resumes after one chat fails',async()=>{
 queueAlert('AAA protection missing',now);queueAlert('AAA protection missing',now);assert.equal(fs.readdirSync(path.join(dir,'alerts')).length,1);
 const sent=[];await assert.rejects(flushAlerts(async id=>{if(id==='2')throw Error();sent.push(id);},['1','2']));
 await flushAlerts(async id=>sent.push(id),['1','2']);assert.deepEqual(sent,['1','2']);
});
test('exposure includes pending orders, partial fills and local intents without double counting',()=>{
 const positions=[{symbol:'AAA',qty:4,avgEntry:100,marketValue:420}];
 const order={id:'entry',client_order_id:'coid',symbol:'AAA',side:'buy',status:'partially_filled',qty:'10',filled_qty:'4',limit_price:'100'};
 const rows={a:{ticker:'AAA',brokerOrderId:'entry',clientOrderId:'coid',status:'partially_filled',qty:10,filledQty:4,entry:100}};
 const exposure=portfolioExposure(positions,[order],rows);assert.equal(exposure.gross,1026);assert.equal(exposure.issues.length,0);
 assert.equal(portfolioExposure(positions,[],rows).gross,1026);
 order.status='pending_cancel';assert.equal(portfolioExposure(positions,[order],rows).gross,1026);
});
test('allocation caps gross exposure, individual equity share, cash and correlated group',()=>{
 const cfg={...LOCAL_DEFAULTS,maxPositionNotional:0},base={cfg,equity:5000,cash:5000,symbol:'NEW',exposure:{gross:0,bySymbol:{},issues:[]}};
 assert.equal(allocationBudget(base).dollars,1000);
 assert.equal(allocationBudget({...base,exposure:{gross:4800,bySymbol:{OLD:4800},issues:[]}}).dollars,200);
 assert.equal(allocationBudget({...base,cash:50}).dollars,50);
 assert.equal(allocationBudget({...base,correlated:['OLD'],exposure:{gross:1800,bySymbol:{OLD:1800},issues:[]}}).dollars,200);
 assert.equal(allocationBudget({...base,equity:2000}).dollars,400);
 assert.equal(allocationBudget({...base,cfg:{...cfg,maxGrossExposurePct:0}}).ok,false);
 assert.equal(allocationBudget({...base,exposure:{gross:0,bySymbol:{},issues:['Unknown order value']}}).ok,false);
});
test('correlations use aligned historical returns and missing samples do not pass',()=>{
 const bars=Array.from({length:65},(_,i)=>({date:new Date(Date.UTC(2026,6,i+1)).toISOString().slice(0,10),close:100+i+Math.sin(i)*2}));
 assert.ok(correlation(bars,bars.map(b=>({...b,close:b.close*2})))>.99);assert.equal(correlation(bars,bars.slice(0,20)),null);
});
test('earnings filter rejects unknown, stale, near-event and market-blocked dates',()=>{
 const cfg={...LOCAL_DEFAULTS,requireEventCoverage:true},today='2026-10-15',item={checkedAt:today,coveredThrough:'2026-10-29',dates:[]};
 assert.equal(eventGate('AAA',{},cfg,now).ok,false);
 assert.equal(eventGate('AAA',{symbols:{AAA:item}},cfg,now).ok,true);
 assert.equal(eventGate('AAA',{symbols:{AAA:{...item,checkedAt:'2026-10-01'}}},cfg,now).ok,false);
 assert.equal(eventGate('AAA',{symbols:{AAA:{...item,dates:['2026-10-22']}}},cfg,now).ok,false);
 assert.equal(eventGate('AAA',{symbols:{AAA:item},blockedDates:[today]},cfg,now).ok,false);
});
test('lost protective-stop acknowledgement is reconciled without adding a second stop',async()=>{
 const {client,state,args}=broker();client.submitMarketExit=async()=>{throw Error('unavailable');};
 const submit=client.submitProtectiveStop;client.submitProtectiveStop=async(...p)=>{await submit(...p);throw Error('lost stop acknowledgement');};
 await recoverExit(args);assert.equal(state.stops.length,1);state.open=false;
 await recoverExit(args);assert.equal(state.stops.length,1);assert.equal(read('exits.json').AAA.phase,'waiting_market');
});
test('broker snapshot failure blocks entries and requests no liquidation',async()=>{
 const {client,state}=broker();client.getOpenOrders=async()=>{throw Error('offline');};
 const status=await auditSafety({client,journal:{},now,pause});assert.equal(status.blocked,true);assert.equal(state.sales.length,0);assert.match(status.issues[0],/Cannot verify/);
});
test('an unknown-price pending order cannot be treated as zero exposure',()=>{
 const value=portfolioExposure([],[{id:'unknown',symbol:'AAA',side:'buy',qty:'20',filled_qty:'0',type:'market',status:'new'}],{});
 assert.equal(value.issues.length,1);assert.equal(allocationBudget({cfg:LOCAL_DEFAULTS,equity:10000,cash:10000,symbol:'BBB',exposure:value}).ok,false);
});
test('a late liquidation fill cancels restored stops before marking the intent closed',async()=>{
 const {client,state,args}=broker();await recoverExit(args);state.position=null;state.orders=[{id:'orphan-stop',symbol:'AAA',side:'sell',type:'stop',status:'new',qty:'10'}];
 await recoverExit(args);assert.equal(state.orders.length,0);assert.equal(state.sales.length,1);assert.equal(read('exits.json').AAA.phase,'closed');
});
test('a durable operator exit is recovered even without a journal row',async()=>{
 const {client,state,args}=broker();client.submitMarketExit=async()=>{throw Error('offline');};await recoverExit(args);
 let attempts=0;client.submitMarketExit=async(s,q,id)=>{attempts++;const order={id:'recovered-exit',side:'sell',symbol:s,type:'market',status:'new',qty:String(q)};state.orders=[order];state.byClient.set(id,order);return order;};
 await auditSafety({client,journal:{},now,pause});assert.equal(attempts,1);assert.equal(read('exits.json').AAA.brokerOrderId,'recovered-exit');
});
test('a partial entry cannot rely on held bracket legs awaiting the remaining fill',async()=>{
 const {client,state}=broker();state.position.qty=4;
 state.orders=[{id:'buy',symbol:'AAA',side:'buy',type:'market',status:'partially_filled',qty:'10',filled_qty:'4',legs:[{id:'held-stop',symbol:'AAA',side:'sell',type:'stop',status:'held',qty:'10',stop_price:'95'}]}];
 await auditSafety({client,journal:{a:{ticker:'AAA',status:'partially_filled',sl:95,sessionDate:'2026-10-14'}},now,pause});
 assert.equal(state.sales.length,1);assert.equal(state.sales[0].qty,4);
});
test('dollar-based broker buys reserve capital and missing IDs cannot hide local intents',()=>{
 const exposure=portfolioExposure([],[{id:'external',symbol:'EXT',side:'buy',status:'new',qty:null,notional:'500'}],{a:{ticker:'AAA',status:'pending_submit',qty:2,entry:100}});
 assert.equal(exposure.gross,707);assert.equal(exposure.bySymbol.AAA,202);
 const unknown=portfolioExposure([],[{id:'external',symbol:'EXT',side:'buy',status:'new',qty:'10'}],{a:{ticker:'AAA',status:'pending_submit',qty:2,entry:100}});
 assert.ok(unknown.issues.length);
});

test('default event policy allows unknown earnings but respects known dates and explicit blocks',()=>{
 assert.equal(LOCAL_DEFAULTS.requireEventCoverage,false);
 assert.equal(eventGate('AAA',{},LOCAL_DEFAULTS,now).ok,true);
 assert.equal(eventGate('AAA',{symbols:{AAA:{dates:['2026-10-22']}}},LOCAL_DEFAULTS,now).ok,false);
 assert.equal(eventGate('AAA',{blockedDates:['2026-10-15']},LOCAL_DEFAULTS,now).ok,false);
});
