import '../scripts/lib/load-env.mjs';
import { broker,dryRun } from './local-worker.mjs';
try {
  const account=await broker().getAccount();
  console.log(`Alpaca PAPER connected; status=${account.status}; dry-run=${dryRun()}`);
  const token=process.env.TELEGRAM_BOT_TOKEN||'';
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(token))throw Error('Telegram token format invalid; edit swing-config/swing.env');
  const res=await fetch(`https://api.telegram.org/bot${token}/getMe`,{signal:AbortSignal.timeout(15000)});
  if(!res.ok||!(await res.json()).ok)throw Error(`Telegram verification failed (HTTP ${res.status})`);
  console.log('Telegram connected. No Firebase required; no orders submitted.');
}catch(e){console.error(String(e.message).replace(/\d+:[A-Za-z0-9_-]+/g,'[REDACTED]'));process.exitCode=1;}
