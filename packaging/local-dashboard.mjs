import '../scripts/lib/load-env.mjs';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { broker,dryRun } from './local-worker.mjs';
import { read,dataDir } from './local-store.mjs';
const PAGE=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RSI2 Bot</title><style>body{font:16px system-ui;background:#101827;color:#e5edf8;max-width:1100px;margin:32px auto;padding:16px}h1{margin-bottom:6px}.muted{color:#a5b5ca}section{background:#19263a;padding:20px;margin:20px 0;border-radius:12px;overflow:auto}.cards{display:flex;gap:32px;flex-wrap:wrap}.value{font-size:28px}table{width:100%;border-collapse:collapse;white-space:nowrap}th,td{text-align:left;padding:10px;border-bottom:1px solid #354459}pre{white-space:pre-wrap;font-size:12px}.green{color:#70dfab}.red{color:#ff9292}</style><h1>RSI2 Bot</h1><p class="muted">Local, single-account Alpaca paper trading</p><p id="state">Loading…</p><section class="cards" id="account"></section><section><h2>Open positions</h2><div id="positions"></div></section><section><h2>Local trade journal</h2><p class="muted">Broker-confirmed realized results only. History begins with this installation.</p><div id="journal"></div></section><section><h2>Recent logs</h2><pre id="logs"></pre></section><script>
const el=id=>document.getElementById(id),money=n=>Number(n).toLocaleString('en-US',{style:'currency',currency:'USD'});
function table(id,head,rows){const t=document.createElement('table');for(const row of [head,...rows]){const tr=document.createElement('tr');for(const value of row){const cell=document.createElement(row===head?'th':'td');cell.textContent=value??'—';tr.append(cell)}t.append(tr)}el(id).replaceChildren(t)}
async function refresh(){try{const r=await fetch('/api/summary');if(!r.ok)throw Error();const d=await r.json();el('state').textContent=(d.paused?'Entries PAUSED':'Entries enabled')+' · '+(d.dryRun?'DRY RUN':'PAPER orders enabled')+' · '+(d.error||'Updated '+new Date(d.at).toLocaleTimeString());el('account').replaceChildren();if(d.account)for(const [label,value]of Object.entries({Equity:d.account.equity,Cash:d.account.cash,'Buying power':d.account.buyingPower})){const div=document.createElement('div');div.textContent=label;const v=document.createElement('div');v.className='value';v.textContent=money(value);div.append(v);el('account').append(div)}table('positions',['Symbol','Qty','Entry','Unrealized P&L'],d.positions.map(p=>[p.symbol,p.qty,money(p.avgEntry),money(p.unrealizedPl)]));table('journal',['Session','Symbol','Qty','Status','Realized P&L'],d.orders.map(o=>[o.sessionDate,o.ticker,o.qty,o.status,o.realizedPnl==null?'Pending':money(o.realizedPnl)]));el('logs').textContent=d.logs}catch{el('state').textContent='Connection failed; retrying…'}}refresh();setInterval(refresh,30000);
</script></html>`;
export function authenticated(header){
  try{if(!header?.startsWith('Basic '))return false;const raw=Buffer.from(header.slice(6),'base64').toString();const split=raw.indexOf(':');const user=raw.slice(0,split),hash=crypto.createHash('sha256').update(raw.slice(split+1)).digest('hex');const expected=process.env.DASHBOARD_PASSWORD_HASH||'';return split>=0&&user===process.env.DASHBOARD_USER&&/^[a-f0-9]{64}$/i.test(expected)&&crypto.timingSafeEqual(Buffer.from(hash),Buffer.from(expected.toLowerCase()));}catch{return false;}
}
export function server({client=broker()}={}){
  let cache=null,at=0,pending;
  async function snapshot(){
    if(!cache||Date.now()-at>30000){
      if(!pending)pending=Promise.all([client.getAccount(),client.getPositions()]).then(([account,positions])=>{cache={account,positions};at=Date.now();}).finally(()=>{pending=null;});
      await pending;
    }
    return cache;
  }
  const failures=new Map();
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
    const ip=req.socket.remoteAddress,fail=failures.get(ip);
    if(fail&&fail.count>=15&&Date.now()-fail.at<60000){res.writeHead(429);res.end('Too many login attempts. Retry in one minute.');return;}
    if(!authenticated(req.headers.authorization)){failures.set(ip,{count:fail&&Date.now()-fail.at<60000?fail.count+1:1,at:Date.now()});res.writeHead(401,{'WWW-Authenticate':'Basic realm="RSI2 dashboard"'});res.end('Authentication required');return;}
    failures.delete(ip);
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(PAGE);return;}
    if(req.url==='/healthz'){res.end('ok');return;}
    if(req.url!=='/api/summary'){res.writeHead(404);res.end();return;}
    try{
      let error=null;try{await snapshot();}catch{error='Alpaca unavailable; displayed broker data may be stale';}
      let logs='No logs yet';try{const file=path.join(dataDir,'logs/swing.log');const fd=fs.openSync(file,'r');try{const size=fs.fstatSync(fd).size,buf=Buffer.alloc(Math.min(size,24000));fs.readSync(fd,buf,0,buf.length,Math.max(0,size-buf.length));logs=buf.toString();}finally{fs.closeSync(fd);}}catch{}
      const orders=Object.values(read('journal.json',{orders:{}}).orders).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,200);
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({...cache,positions:cache?.positions||[],at:at||null,error,paused:read('control.json',{paused:true}).paused,dryRun:dryRun(),orders,logs}));
    }catch{res.writeHead(500);res.end('Local data unavailable; inspect container logs');}
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){server().listen(Number(process.env.DASHBOARD_PORT||8444),process.env.DASHBOARD_BIND||'127.0.0.1');}
