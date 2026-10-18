/* RSI2 account equity and realized P&L views. No third-party requests. */
(function (root) {
  'use strict';
  var state = {data:null, month:null, day:null, range:90};
  function esc(s){return String(s == null ? '' : s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function dollars(n){return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n);}
  function signed(n){return (n>0?'+':'')+dollars(n);}
  function tone(n){return n>0?'positive':n<0?'negative':'muted';}
  function dateKey(d){return d.toISOString().slice(0,10);}
  function monthRows(month, days){
    var first=new Date(month+'-01T00:00:00Z'), last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0));
    var start=new Date(first); start.setUTCDate(1-(first.getUTCDay()+6)%7);
    var lookup={}; (days||[]).forEach(function(d){lookup[d.date]=d;});
    var rows=[];
    for(var cursor=new Date(start);cursor<=last;){
      var week={cells:[],pnl:0,count:0};
      for(var i=0;i<7;i++){
        var key=dateKey(cursor), active=key.slice(0,7)===month, day=lookup[key];
        week.cells.push({date:key,active:active,record:day||null});
        if(active&&day){week.pnl+=Number(day.pnl)||0;week.count+=day.count||0;}
        cursor.setUTCDate(cursor.getUTCDate()+1);
      }
      rows.push(week);
    }
    return rows;
  }
  function shiftMonth(delta){
    var d=new Date(state.month+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+delta);
    var next=dateKey(d).slice(0,7), now=state.data.now.slice(0,7), since=state.data.history.since_date;
    if(next>now || (since&&next<since.slice(0,7)))return;
    state.month=next;state.day=null;render(state.data);
  }
  function selectDay(day){state.day=day;render(state.data);}
  function setRange(n){state.range=n;render(state.data);}
  function renderCalendar(data){
    var box=document.getElementById('pnlcalendar'), detail=document.getElementById('caldetail'), hist=data.history||{};
    if(hist.error){box.innerHTML='<p class="negative">Trade history unavailable: '+esc(hist.error)+'</p>';detail.innerHTML='';return;}
    var rows=monthRows(state.month,hist.days), total=rows.reduce(function(n,w){return n+w.pnl;},0);
    var label=new Date(state.month+'-01T00:00:00Z').toLocaleDateString('en-US',{month:'long',year:'numeric',timeZone:'UTC'});
    var html='<div class="calendar-heading"><div class="row"><button aria-label="Previous month" onclick="SwingPerformance.shiftMonth(-1)">&#8249;</button><strong>'+esc(label)+'</strong><button aria-label="Next month" onclick="SwingPerformance.shiftMonth(1)">&#8250;</button></div><span>Monthly realized P&amp;L: <b class="'+tone(total)+'">'+signed(total)+'</b></span></div><div class="calendar-scroll"><table class="pnl-calendar"><thead><tr>';
    ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday','Total'].forEach(function(n){html+='<th>'+n+'</th>';});html+='</tr></thead><tbody>';
    rows.forEach(function(week,index){html+='<tr>';week.cells.forEach(function(cell){
      if(!cell.active){html+='<td class="outside"></td>';return;}
      var future=cell.date>data.now.slice(0,10), outside=hist.since_date&&cell.date<hist.since_date, record=cell.record;
      var note=future?'Upcoming':outside?'Outside loaded history':record?(record.count+' trade'+(record.count===1?'':'s')):'No closed trades';
      html+='<td class="'+(state.day===cell.date?'selected':'')+'"><button '+(future||outside?'disabled':'')+' onclick="SwingPerformance.selectDay(\''+cell.date+'\')" aria-label="'+cell.date+' '+esc(note)+'"><span class="calendar-date">'+Number(cell.date.slice(8))+'</span><span class="'+tone(record?record.pnl:0)+'">'+(record?signed(record.pnl):'—')+'</span><small>'+esc(note)+'</small></button></td>';
    });html+='<td class="week-total"><strong>Week '+(index+1)+'</strong><span class="'+tone(week.pnl)+'">'+signed(week.pnl)+'</span><small>'+week.count+' trades</small></td></tr>';});
    box.innerHTML=html+'</tbody></table></div>';
    var selected=(hist.days||[]).find(function(d){return d.date===state.day;});
    if(!state.day){detail.innerHTML='<p class="note">Select a day to inspect its closed trades. Daily and weekly totals use broker-confirmed results before fees, grouped by the date recorded in the local journal.</p>';return;}
    var text='<h3>'+esc(state.day)+' — closed trades</h3>';
    if(!selected){detail.innerHTML=text+'<p class="empty">No closed trades recorded.</p>';return;}
    text+='<div class="tblwrap"><table><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Exit reason</th></tr>';
    selected.trades.forEach(function(t){text+='<tr><td>'+esc(t.symbol)+'</td><td>'+esc(t.direction)+'</td><td>'+esc(t.qty)+'</td><td>'+dollars(t.entry)+'</td><td>'+dollars(t.exit)+'</td><td class="'+tone(t.pnl)+'">'+signed(t.pnl)+'</td><td>'+esc(t.outcome)+'</td></tr>';});
    detail.innerHTML=text+'</table></div>';
  }
  function chartPoints(points, range){
    var valid=(points||[]).filter(function(p){return /^\d{4}-\d{2}-\d{2}$/.test(p.date)&&Number.isFinite(p.equity)&&p.equity>=0;}).slice().sort(function(a,b){return a.date.localeCompare(b.date);});
    if(!valid.length)return [];
    var cutoff=new Date(valid[valid.length-1].date+'T00:00:00Z');cutoff.setUTCDate(cutoff.getUTCDate()-range+1);
    return valid.filter(function(p){return p.date>=dateKey(cutoff);});
  }
  function renderBalance(data){
    var node=document.getElementById('balancechart'), controls=document.getElementById('balancerange'), hist=data.balance||{};
    controls.innerHTML=[7,30,90].map(function(n){return '<button '+(n===state.range?'aria-pressed="true"':'aria-pressed="false"')+' onclick="SwingPerformance.setRange('+n+')">'+n+' days</button>';}).join(' ');
    if(hist.error){node.innerHTML='<p class="negative">Equity history unavailable: '+esc(hist.error)+'</p>';return;}
    var points=chartPoints(hist.points,state.range);
    if(points.length<2){node.innerHTML='<p class="empty">At least two account-equity observations are needed for a chart.</p>';return;}
    var min=Math.min.apply(null,points.map(function(p){return p.equity;})),max=Math.max.apply(null,points.map(function(p){return p.equity;})),padding=Math.max((max-min)*.12,1);min-=padding;max+=padding;
    var width=Math.max(320,Math.min(1000,node.clientWidth||1000)),left=80,right=width-25,top=20,bottom=215,first=Date.parse(points[0].date),last=Date.parse(points[points.length-1].date);
    function x(p){return left+(Date.parse(p.date)-first)/(last-first||1)*(right-left);}
    function y(p){return bottom-(p.equity-min)/(max-min)*(bottom-top);}
    var start=points[0],end=points[points.length-1],delta=end.equity-start.equity;
    var svg='<div class="balance-heading"><strong>'+dollars(end.equity)+'</strong><span class="'+tone(delta)+'">'+signed(delta)+' balance change in displayed period</span></div><svg viewBox="0 0 '+width+' 255" role="img" aria-label="Account equity from '+start.date+' to '+end.date+'"><title>Account equity: '+dollars(start.equity)+' to '+dollars(end.equity)+'</title>';
    for(var i=0;i<4;i++){var value=min+(max-min)*i/3, yy=y({equity:value});svg+='<line x1="'+left+'" x2="'+right+'" y1="'+yy+'" y2="'+yy+'" class="chart-grid"/><text x="'+(left-10)+'" y="'+(yy+4)+'" text-anchor="end" class="chart-label">'+esc(dollars(value))+'</text>';}
    svg+='<polyline class="balance-line" points="'+points.map(function(p){return x(p)+','+y(p);}).join(' ')+'"/>';
    points.forEach(function(p){svg+='<circle cx="'+x(p)+'" cy="'+y(p)+'" r="4" class="balance-dot" tabindex="0"><title>'+p.date+': '+dollars(p.equity)+'</title></circle>';});
    svg+='<text x="'+left+'" y="245" class="chart-label">'+start.date+'</text><text x="'+right+'" y="245" text-anchor="end" class="chart-label">'+end.date+'</text></svg>';
    node.innerHTML=svg;
  }
  function render(data){state.data=data;if(!state.month)state.month=data.now.slice(0,7);renderCalendar(data);renderBalance(data);}
  var api={monthRows:monthRows,chartPoints:chartPoints,render:render,shiftMonth:shiftMonth,selectDay:selectDay,setRange:setRange};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SwingPerformance=api;
})(typeof window!=='undefined'?window:globalThis);
