import '../scripts/lib/load-env.mjs';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { read,write,config } from './local-store.mjs';
import { flushAlerts } from './local-safety.mjs';
import { dateET } from './local-risk.mjs';
import { broker,dryRun } from './local-worker.mjs';
import { attachFileLog } from '../scripts/lib/logfile.mjs';
const exec=promisify(execFile);
export function authorized(id){return (process.env.TELEGRAM_ALLOWED_CHAT_IDS||'').split(',').map(s=>s.trim()).includes(String(id));}
export async function command(text,{client=broker(),run=exec}={}){
  const [name,arg,...extra]=text.trim().split(/\s+/);
  switch(name.split('@')[0].toLowerCase()){
    case '/start':case '/help':return '/status /healthcheck /positions /pnl /config /safety /earnings /earningsfilter /eventblock /pause /resume /set <key> <value> /deploycheck /deploy CONFIRM /flatten CONFIRM';
    case '/status':return `Safety ${read('safety.json',{}).blocked?'BLOCKED':'see /safety'}. RSI2 PAPER. Entries ${read('control.json',{paused:true}).paused?'PAUSED':'enabled'}. DRY_RUN=${dryRun()}. Pause blocks new entries; managed exits continue.`;
    case '/health':case '/healthcheck':{
      const dashboard=process.env.DASHBOARD_URL?.trim();
      const link=dashboard||'http://127.0.0.1:8444 (on the bot PC; remote URL is not configured)';
      const entries=read('control.json',{paused:true}).paused?'Entries: PAUSED. Send /resume to enable entries.':'Entries: enabled (subject to schedule and safety filters).';
      const details=entries+'\nDRY_RUN='+dryRun()+'\nPause blocks new entries; managed exits continue.\nDashboard: '+link;
      try{return (await run('python3',['packaging/runtime.py','health'],{timeout:15000})).stdout.trimEnd()+'\n'+details;}
      catch{return 'Health check failed. Inspect the dashboard logs.\n'+details;}
    }
    case '/safety':{const state=read('safety.json',null);return state?JSON.stringify(state,null,2):'Safety audit has not run yet; keep entries paused.';}
    case '/earnings':{
      if(!arg)return 'Usage: /earnings SYMBOL YYYY-MM-DD[,YYYY-MM-DD] or /earnings SYMBOL none. Confirms you checked the next 21 calendar days. Review at least weekly.';
      const symbol=arg.toUpperCase(),input=extra.join('');
      if(!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)||!input)return 'Invalid symbol/dates';
      const dates=input==='none'?[]:input.split(',');
      if(dates.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d))return 'Invalid earnings date';
      const now=new Date(),day=dateET(now),events=read('events.json',{}),coveredThrough=new Date(Date.parse(day+'T12:00:00Z')+21*86400000).toISOString().slice(0,10);
      events.symbols={...events.symbols,[symbol]:{checkedAt:day,coveredThrough,dates}};write('events.json',events);
      return `${symbol}: earnings coverage saved through ${coveredThrough}; dates ${dates.join(', ')||'none reported'}. Recheck within 7 days. No entry is guaranteed.`;
    }
    case '/earningsfilter':{
      if(!['on','off'].includes(arg))return 'Usage: /earningsfilter on|off. Default off: unknown earnings do not block entries. Known dates and explicit market-event blocks still apply.';
      write('config.json',{...read('config.json',{}),requireEventCoverage:arg==='on'});
      return arg==='on'?'Verified earnings coverage is now required for entries.':'Manual earnings coverage is optional. Unknown dates do not block entries; known earnings and market-event blocks still apply. Exit and exposure controls remain enabled.';
    }
    case '/eventblock':{
      if(!arg||!/^\d{4}-\d{2}-\d{2}$/.test(arg)||!Number.isFinite(Date.parse(arg))||new Date(arg).toISOString().slice(0,10)!==arg)return 'Usage: /eventblock YYYY-MM-DD (blocks new entries for a market event)';
      const events=read('events.json',{});events.blockedDates=[...new Set([...(events.blockedDates||[]),arg])];write('events.json',events);return `New entries blocked on ${arg}; existing protection and exits continue.`;
    }
    case '/positions':{
      const rows=await client.getPositions();return rows.length?rows.map(p=>`${p.symbol}: ${p.qty} shares @ ${p.avgEntry}; unrealized $${p.unrealizedPl.toFixed(2)}`).join('\n'):'No open positions';
    }
    case '/pnl':{const a=await client.getAccount();return `Equity $${a.equity.toFixed(2)}; cash $${a.cash.toFixed(2)}; change since previous close $${(a.equity-a.lastEquity).toFixed(2)}`;}
    case '/pause':write('control.json',{paused:true});return 'New entries PAUSED. Managed exits continue.';
    case '/resume':write('control.json',{paused:false});return `New entries enabled. DRY_RUN=${dryRun()} (change swing.env and recreate container to enable paper orders). Safety and event filters still apply; inspect /safety.`;
    case '/config':{const c=config();return JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k])=>!['apiKey','apiSecret','updatedAt'].includes(k))),null,2);}
    case '/set':{
      const ranges={riskPerTradePct:[0.01,2],maxConcurrentPositions:[1,50],maxPositionsPerSector:[1,50],maxPortfolioHeatPct:[0.1,20],dailyLossHaltPct:[0.1,20],maxDrawdownHaltPct:[0.1,50],maxPositionNotional:[1,100000],maxGrossExposurePct:[1,100],maxPositionEquityPct:[1,100],maxCorrelatedExposurePct:[1,100],fixedNotional:[1,100000]};
      const range=ranges[arg],n=Number(extra[0]);
      if(!range||extra.length!==1||!Number.isFinite(n)||n<range[0]||n>range[1]||(/Positions/.test(arg)&&!Number.isInteger(n)))return 'Use /set with a supported numeric risk setting; see /config. Invalid or out-of-range value.';
      write('config.json',{...read('config.json',{}),[arg]:n});return `${arg}=${n}. Applies on next worker pass.`;
    }
    case '/deploycheck':return (await run('python3',['packaging/runtime.py','deploy','main','--check'],{timeout:120000})).stdout;
    case '/deploy':case '/flatten':{
      if(arg!=='CONFIRM')return `Send ${name} CONFIRM to ${name==='/flatten'?'close all positions in this dedicated paper account':'update from main'}.`;
      return (await run('python3',['packaging/runtime.py',name==='/deploy'?'deploy':'flatten'],{timeout:1300000})).stdout||'Request completed; check /status and /positions.';
    }
    default:return 'Unknown command. Send /help.';
  }
}
export async function poll(){
  const token=process.env.TELEGRAM_BOT_TOKEN||'';
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(token))throw Error('Invalid Telegram token format');
  const api=async(method,body)=>{const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(40000)});const d=await r.json();if(!r.ok||!d.ok)throw Error(`Telegram HTTP ${r.status}`);return d.result;};
  let offset=read('telegram.json',{offset:0}).offset;
  for(;;){
    try{
      const chatIds=(process.env.TELEGRAM_ALLOWED_CHAT_IDS||'').split(',').map(s=>s.trim()).filter(s=>/^-?\d+$/.test(s));
      try{await flushAlerts((id,text)=>api('sendMessage',{chat_id:id,text:String(text).slice(0,4000)}),chatIds);}catch{console.error('[telegram] Safety alert delivery pending; will retry');}
      for(const update of await api('getUpdates',{offset,timeout:25,allowed_updates:['message']})){
        // Persist before executing to prevent replaying destructive commands.
        offset=update.update_id+1;write('telegram.json',{offset});
        const msg=update.message;
        if(!msg?.text||!authorized(msg.chat.id))continue;
        let answer;
        try{answer=await command(msg.text);}catch{answer='Command failed. Check dashboard logs; verify broker connectivity and local configuration.';}
        await api('sendMessage',{chat_id:msg.chat.id,text:String(answer).slice(0,4000)});
      }
    }catch{console.error('[telegram] Request failed; retrying in 5 seconds');await new Promise(r=>setTimeout(r,5000));}
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){attachFileLog('telegram');poll().catch(()=>{console.error('Telegram startup failed; check local token configuration');process.exitCode=1;});}
