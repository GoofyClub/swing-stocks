/* Local RSI2 dashboard. All broker/journal text is inserted as text, not markup. */
(function(){
  'use strict';
  var latest=null,days=30,inflight=false;
  var el=function(id){return document.getElementById(id);};
  function money(n){return n==null||!Number.isFinite(Number(n))?'—':Number(n).toLocaleString('en-US',{style:'currency',currency:'USD'});}
  function signed(n){return n>0?'+'+money(n):money(n);}
  function tone(n){return n>0?'up':n<0?'down':'';}
  function stats(id,rows){el(id).replaceChildren();rows.forEach(function(row){var stat=document.createElement('div');stat.className='stat';var key=document.createElement('div');key.className='k';key.textContent=row[0];var val=document.createElement('div');val.className='v '+(row[2]||'');val.textContent=row[1];stat.append(key,val);el(id).append(stat);});}
  function table(id,heads,rows,empty){el(id).replaceChildren();if(!rows.length){var p=document.createElement('p');p.className='empty';p.textContent=empty;el(id).append(p);return;}var wrap=document.createElement('div');wrap.className='tblwrap';var t=document.createElement('table'),thead=document.createElement('thead'),tr=document.createElement('tr');heads.forEach(function(h){var th=document.createElement('th');th.textContent=h;tr.append(th);});thead.append(tr);t.append(thead);var body=document.createElement('tbody');rows.forEach(function(row){var tr=document.createElement('tr');row.forEach(function(value){var td=document.createElement('td');if(value&&typeof value==='object'){td.textContent=value.text;td.className=value.className||'';}else td.textContent=value==null?'—':value;tr.append(td);});body.append(tr);});t.append(body);wrap.append(t);el(id).append(wrap);}
  function pill(label,cls){var span=document.createElement('span');span.className='pill '+(cls||'');span.textContent=label;el('pills').append(span);}
  function age(n){return n==null?'No heartbeat':n<60?Math.round(n)+' sec ago':Math.round(n/60)+' min ago';}
  function render(d){
    latest=d;el('clock').textContent=d.now+' · refreshes every 30s';el('notice').textContent=d.error||'';el('notice').className='notice '+(d.error?'down':'');
    el('pills').replaceChildren();pill(d.paused?'PAUSED':'ACTIVE',d.paused?'warn':'ok');pill(d.dryRun?'DRY RUN':'PAPER ORDERS',d.dryRun?'warn':'ok');pill(d.market?(d.market.isOpen?'Market open':'Market closed'):'Market unavailable');
    if(d.error)pill('Broker unavailable','bad');
    if(!d.safety||d.safety.blocked)pill(d.safety?'Safety: entries blocked':'Safety audit pending','warn');
    if(d.eventCoverage?.required&&!d.eventCoverage.eligibleReviewedSymbols)pill('No symbols cleared by event filter','warn');
    var h=d.health||{};if(h.supervisorAge==null||h.supervisorAge>15||h.schedulerAge==null||h.schedulerAge>1300)pill('Check runtime','warn');
    stats('health',[['Strategy','RSI2'],['Supervisor',age(h.supervisorAge)],['Scheduler',age(h.schedulerAge)],['Broker updated',d.at?new Date(d.at).toLocaleTimeString('en-US',{timeZone:'America/New_York'})+' ET':'Unavailable']]);
    var a=d.account||{},delta=a.equity!=null&&a.lastEquity!=null?a.equity-a.lastEquity:null;
    stats('account',[['Equity',money(a.equity)],['Day P&L',signed(delta),tone(delta)],['Day %',a.lastEquity>0?(delta/a.lastEquity*100).toFixed(2)+'%':'—',tone(delta)],['Cash',money(a.cash)],['Buying power',money(a.buyingPower)]]);
    table('positions',['Symbol','Qty','Entry','Market value','Unrealized P&L'],(d.positions||[]).map(function(p){return [p.symbol,p.qty,money(p.avgEntry),money(p.marketValue),{text:signed(p.unrealizedPl),className:tone(p.unrealizedPl)}];}),d.error?'Positions unavailable; check broker connection.':'Flat — no open positions.');
    var safety=d.safety,exposure=d.exposure;
    stats('safetystats',[['Protection audit',!safety?'Pending':safety.blocked?'BLOCKED':'Clear',safety?.blocked?'down':''],['Last audit',safety?new Date(safety.at).toLocaleTimeString('en-US',{timeZone:'America/New_York'})+' ET':'—'],['Gross + pending',exposure&&!exposure.issues.length?money(exposure.gross):'Unavailable'],['Earnings-reviewed symbols',d.eventCoverage?.eligibleReviewedSymbols??0]]);
    el('safetyissues').replaceChildren();
    var issues=(safety?.issues||[]).concat(Object.entries(safety?.entryBlocks||{}).map(function(pair){return pair[0]+': '+pair[1]+' candidates in last scan';}));
    issues.forEach(function(issue){var line=document.createElement('p');line.className='note warn';line.textContent=issue;el('safetyissues').append(line);});
    SwingPerformance.render(d);renderJournal();
    var c=d.settings||{},pct=function(v){return v==null?'—':v+'%';};
    stats('config',[['Sizing',c.sizingMode||'—'],['Risk / trade',pct(c.riskPerTradePct)],['Max positions',c.maxConcurrentPositions??'—'],['Max / sector',c.maxPositionsPerSector??'—'],['Portfolio heat',pct(c.maxPortfolioHeatPct)],['Daily halt',pct(c.dailyLossHaltPct)],['Drawdown halt',pct(c.maxDrawdownHaltPct)],['Regime filter',c.respectRegime?'On':'Off'],['Slippage budget',pct(c.slippageBudgetPct)],['Gross cap',pct(c.maxGrossExposurePct)],['Stock cap',pct(c.maxPositionEquityPct)],['Correlated cap',pct(c.maxCorrelatedExposurePct)],['Earnings review',c.requireEventCoverage?'Required':'Disabled']]);
    el('logs').textContent=d.logs||'No logs yet';
  }
  function renderJournal(){
    var cutoff=new Date(latest.now.slice(0,10)+'T00:00:00Z');cutoff.setUTCDate(cutoff.getUTCDate()-days+1);cutoff=cutoff.toISOString().slice(0,10);
    var orders=(latest.orders||[]).filter(function(o){return (o.sessionDate||String(o.createdAt||'').slice(0,10))>=cutoff;});
    var closed=orders.filter(function(o){return o.realizedSource&&Number.isFinite(o.realizedPnl);}),pnl=closed.reduce(function(n,o){return n+o.realizedPnl;},0),wins=closed.filter(function(o){return o.realizedPnl>0;}).length;
    stats('tradetotals',[['Journal entries',orders.length],['Realized trades',closed.length],['Realized P&L',signed(pnl),tone(pnl)],['Win rate',closed.length?(wins/closed.length*100).toFixed(1)+'%':'—']]);
    table('journal',['Session','Symbol','Qty','Status','Entry','Exit','Realized P&L','R','Exit reason'],orders.map(function(o){var known=o.realizedSource&&Number.isFinite(o.realizedPnl);return [o.sessionDate,o.ticker,o.filledQty??o.qty,String(o.status||'').replace(/_/g,' '),money(o.filledAvgPrice??o.entry),known?money(o.realizedExit):'—',known?{text:signed(o.realizedPnl),className:tone(o.realizedPnl)}:'Pending',known&&Number.isFinite(o.realizedR)?o.realizedR.toFixed(2)+'R':'—',o.realizedExitReason||'—'];}),'No journal entries in this period.');
    document.querySelectorAll('[data-days]').forEach(function(b){b.className='daysel '+(Number(b.dataset.days)===days?'on':'');b.setAttribute('aria-pressed',String(Number(b.dataset.days)===days));});
  }
  function theme(){var dark=document.documentElement.dataset.theme==='dark';el('themebtn').textContent=dark?'Light':'Dark';el('themebtn').setAttribute('aria-pressed',String(dark));}
  el('themebtn').addEventListener('click',function(){document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';try{localStorage.setItem('swing-theme',document.documentElement.dataset.theme);}catch(e){}theme();});theme();
  document.querySelectorAll('[data-days]').forEach(function(b){b.addEventListener('click',function(){days=Number(b.dataset.days);if(latest)renderJournal();});});
  async function refresh(){if(inflight)return;inflight=true;try{var r=await fetch('/api/summary',{cache:'no-store'});if(!r.ok)throw Error();render(await r.json());}catch(e){el('notice').textContent='Refresh failed — displayed data may be stale. Retrying automatically.';el('notice').className='notice down';}finally{inflight=false;}}
  window.addEventListener('resize',function(){if(latest)SwingPerformance.render(latest);});
  el('refresh').addEventListener('click',refresh);refresh();setInterval(refresh,30000);
})();
