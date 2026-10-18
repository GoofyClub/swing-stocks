import '../scripts/lib/load-env.mjs';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { broker,dryRun } from './local-worker.mjs';
import { read,dataDir,config } from './local-store.mjs';
const PAGE=fs.readFileSync(new URL('./dashboard.html',import.meta.url),'utf8');
export function authenticated(header){
  try{if(!header?.startsWith('Basic '))return false;const raw=Buffer.from(header.slice(6),'base64').toString();const split=raw.indexOf(':');const user=raw.slice(0,split),hash=crypto.createHash('sha256').update(raw.slice(split+1)).digest('hex');const expected=process.env.DASHBOARD_PASSWORD_HASH||'';return split>=0&&user===process.env.DASHBOARD_USER&&/^[a-f0-9]{64}$/i.test(expected)&&crypto.timingSafeEqual(Buffer.from(hash),Buffer.from(expected.toLowerCase()));}catch{return false;}
}
const dayET=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
export function performanceHistory(orders,now=new Date()){
  const since=new Date(now.getTime()-89*86400000),since_date=dayET(since),days=new Map();
  for(const order of orders){
    if(!order.realizedSource||!Number.isFinite(order.realizedPnl)||!order.realizedAt||!Number.isFinite(Date.parse(order.realizedAt)))continue;
    const date=dayET(order.realizedAt);if(date<since_date)continue;
    if(!days.has(date))days.set(date,{date,pnl:0,count:0,trades:[]});
    const day=days.get(date);day.pnl+=order.realizedPnl;day.count++;
    day.trades.push({symbol:order.ticker,direction:order.side==='sell'?'short':'long',qty:order.filledQty??order.qty,entry:order.filledAvgPrice??order.entry,exit:order.realizedExit,pnl:order.realizedPnl,outcome:order.realizedExitReason||'broker fill'});
  }
  return {since_date,days:[...days.values()].sort((a,b)=>b.date.localeCompare(a.date))};
}
export function equityHistory(raw){
  const points=new Map();
  for(const [i,stamp] of (raw.timestamp||[]).entries()){
    const value=raw.equity?.[i];if(!Number.isFinite(stamp)||value==null||!Number.isFinite(Number(value))||Number(value)<0)continue;
    const date=dayET(stamp*1000);points.set(date,{date,equity:Number(value)});
  }
  return {points:[...points.values()].sort((a,b)=>a.date.localeCompare(b.date))};
}
export function server({client=broker()}={}){
  let cache=null,at=0,pending,balance=null,balanceAt=0,balancePending;
  async function snapshot(){
    if(!cache||Date.now()-at>30000){
      if(!pending)pending=Promise.all([client.getAccount(),client.getPositions(),client.getClock?.()]).then(([account,positions,clock])=>{cache={account,positions,market:clock?{isOpen:clock.isOpen,nextOpen:clock.nextOpen,nextClose:clock.nextClose}:null};at=Date.now();}).finally(()=>{pending=null;});
      await pending;
    }
    return cache;
  }
  async function balances(){
    if(!balance||Date.now()-balanceAt>300000){
      if(!balancePending)balancePending=Promise.resolve().then(()=>{if(!client.getPortfolioHistory)throw Error();return client.getPortfolioHistory({period:'3M',timeframe:'1D',extendedHours:false,raw:true});}).then(raw=>{balance=equityHistory(raw);}).catch(()=>{balance={error:'Alpaca equity history unavailable'};}).finally(()=>{balanceAt=Date.now();balancePending=null;});
      await balancePending;
    }
    return balance;
  }
  const failures=new Map();
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'");
    const ip=req.socket.remoteAddress,fail=failures.get(ip);
    if(fail&&fail.count>=15&&Date.now()-fail.at<60000){res.writeHead(429);res.end('Too many login attempts. Retry in one minute.');return;}
    if(!authenticated(req.headers.authorization)){failures.set(ip,{count:fail&&Date.now()-fail.at<60000?fail.count+1:1,at:Date.now()});res.writeHead(401,{'WWW-Authenticate':'Basic realm="RSI2 dashboard"'});res.end('Authentication required');return;}
    failures.delete(ip);
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(PAGE);return;}
    const assets={'/assets/dashboard.css':['dashboard.css','text/css'],'/assets/dashboard.js':['dashboard.js','application/javascript'],'/assets/performance.js':['performance.js','application/javascript']};
    if(assets[req.url]){const [file,type]=assets[req.url];res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});res.end(fs.readFileSync(new URL(file,import.meta.url)));return;}
    if(req.url==='/healthz'){res.end('ok');return;}
    if(req.url!=='/api/summary'){res.writeHead(404);res.end();return;}
    try{
      let error=null;try{await Promise.all([snapshot(),balances()]);}catch{error='Alpaca unavailable; displayed broker data may be stale';}
      let logs='No logs yet';try{const file=path.join(dataDir,'logs/swing.log');const fd=fs.openSync(file,'r');try{const size=fs.fstatSync(fd).size,buf=Buffer.alloc(Math.min(size,24000));fs.readSync(fd,buf,0,buf.length,Math.max(0,size-buf.length));logs=buf.toString();}finally{fs.closeSync(fd);}}catch{}
      const orders=Object.values(read('journal.json',{orders:{}}).orders).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
      const cfg=config(),settings=Object.fromEntries(['riskPerTradePct','sizingMode','fixedNotional','maxPositionNotional','maxConcurrentPositions','maxPositionsPerSector','maxPortfolioHeatPct','dailyLossHaltPct','maxDrawdownHaltPct','respectRegime','slippageBudgetPct'].map(key=>[key,cfg[key]]));
      const now=new Date(),runtime=read('runtime.json',null),scheduler=read('scheduler.json',null);
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({...cache,positions:cache?.positions||[],at:at||null,error,paused:read('control.json',{paused:true}).paused,dryRun:dryRun(),orders:orders.slice(0,200),history:performanceHistory(orders,now),balance,now:dayET(now)+' '+now.toLocaleTimeString('en-US',{timeZone:'America/New_York'})+' ET',settings,health:{supervisorAge:runtime?Math.max(0,(Date.now()/1000-runtime.at)):null,schedulerAge:scheduler?Math.max(0,(Date.now()/1000-scheduler.at)):null},logs}));
    }catch{res.writeHead(500);res.end('Local data unavailable; inspect container logs');}
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){server().listen(Number(process.env.DASHBOARD_PORT||8444),process.env.DASHBOARD_BIND||'127.0.0.1');}
