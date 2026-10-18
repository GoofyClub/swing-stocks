// Pure local risk controls. No broker writes or external calendar dependency.
export const LOCAL_DEFAULTS = {
  riskPerTradePct: 0.25, maxConcurrentPositions: 5, maxPortfolioHeatPct: 2,
  maxGrossExposurePct: 100, maxPositionEquityPct: 20,
  maxCorrelatedExposurePct: 40, correlationThreshold: 0.7,
  correlationMinObservations: 40, requireEventCoverage: false,
  eventWindowDays: 14, eventCalendarFreshDays: 7,
};
export const dateET = date => new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const validDay = day => typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day;
const plusDays = (day,n) => new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
export const flattenOrders = list => [...new Map(list.flatMap(o=>[o,...flattenOrders(o.legs||[])]).map(o=>[o.id,o])).values()];
export const isWorking = o => !['filled','canceled','cancelled','rejected','expired','replaced','done_for_day','pending_cancel'].includes(o.status);
export function eventGate(symbol,events,cfg,now){
  const today=dateET(now);
  if(events.blockedDates?.includes(today))return {ok:false,reason:'Entry date blocked for a market event'};
  const item=events.symbols?.[symbol];
  if(item){
    if(!Array.isArray(item.dates)||item.dates.some(d=>!validDay(d)))return {ok:false,reason:'Invalid earnings dates'};
    if(item.dates.some(day=>day>=today&&day<=plusDays(today,cfg.eventWindowDays)))return {ok:false,reason:`Earnings within ${cfg.eventWindowDays} calendar days`};
  }
  if(cfg.requireEventCoverage&&(!item||!validDay(item.checkedAt)||!validDay(item.coveredThrough)||item.checkedAt<plusDays(today,-cfg.eventCalendarFreshDays)||item.checkedAt>today||!item.checkedAt||!item.coveredThrough||item.coveredThrough<plusDays(today,cfg.eventWindowDays)))return {ok:false,reason:'Earnings coverage missing, stale or too short'};
  return {ok:true};
}
export function validateLimits(cfg){
  for(const key of ['maxGrossExposurePct','maxPositionEquityPct','maxCorrelatedExposurePct'])if(!Number.isFinite(cfg[key])||cfg[key]<=0||cfg[key]>100)return `Invalid ${key} (must be >0 and <=100)`;
  if(!Number.isFinite(cfg.correlationThreshold)||cfg.correlationThreshold<=0||cfg.correlationThreshold>=1)return 'Invalid correlation threshold';
  if(!Number.isInteger(cfg.correlationMinObservations)||cfg.correlationMinObservations<20)return 'Insufficient correlation sample requirement';
  if(!Number.isInteger(cfg.eventWindowDays)||cfg.eventWindowDays<14||!Number.isInteger(cfg.eventCalendarFreshDays)||cfg.eventCalendarFreshDays<1||cfg.eventCalendarFreshDays>7||typeof cfg.requireEventCoverage!=='boolean')return 'Invalid event-calendar policy';
  return null;
}
export function portfolioExposure(positions,orders,journal){
  const exposure=new Map(),seen=new Set(),issues=[];
  for(const p of positions){
    const qty=Number(p.qty),value=Math.max(Math.abs(Number(p.marketValue)||0),Math.abs(qty*(Number(p.avgEntry)||0)));
    if(!(qty>0)||!(value>0)){issues.push(`Cannot value long holding ${p.symbol}`);continue;}
    exposure.set(p.symbol,(exposure.get(p.symbol)||0)+value);
  }
  const reserve=(symbol,qty,price)=>{
    if(!Number.isFinite(qty)){issues.push(`Cannot value pending quantity ${symbol}`);return;}
    if(qty<=0)return;
    if(!Number.isFinite(price)||price<=0){issues.push(`Cannot value pending entry ${symbol}`);return;}
    exposure.set(symbol,(exposure.get(symbol)||0)+qty*price);
  };
  for(const o of flattenOrders(orders)){
    if(o.side!=='buy'||(!isWorking(o)&&o.status!=='pending_cancel'))continue;
    if(o.id)seen.add(o.id);if(o.client_order_id)seen.add(o.client_order_id);
    if(o.qty==null){
      if(Number(o.notional)>0)exposure.set(o.symbol,(exposure.get(o.symbol)||0)+Number(o.notional)*1.01);
      else issues.push(`Cannot value pending entry ${o.symbol}`);
      continue;
    }
    const row=Object.values(journal).find(r=>(o.id&&r.brokerOrderId===o.id)||(o.client_order_id&&r.clientOrderId===o.client_order_id));
    const price=Math.max(Number(o.limit_price)||0,Number(o.stop_price)||0,Number(row?.entry)||0);
    reserve(o.symbol,Number(o.qty)-Number(o.filled_qty||0),price*1.01);
  }
  for(const row of Object.values(journal)){
    if(!['pending_submit','submitted','partially_filled'].includes(row.status)||seen.has(row.brokerOrderId)||seen.has(row.clientOrderId))continue;
    const held=positions.find(p=>p.symbol===row.ticker);
    reserve(row.ticker,Math.max(0,Number(row.qty)-Math.max(Number(row.filledQty)||0,Number(held?.qty)||0)),Number(row.entry)*1.01);
  }
  return {bySymbol:Object.fromEntries(exposure),gross:[...exposure.values()].reduce((a,b)=>a+b,0),issues};
}
export function allocationBudget({cfg,equity,cash,exposure,symbol,correlated=[]}){
  const invalid=validateLimits(cfg);if(invalid)return {ok:false,reason:invalid};
  if(!(equity>0)||!Number.isFinite(cash)||exposure.issues.length)return {ok:false,reason:exposure.issues[0]||'Account valuation unavailable'};
  const group=[...new Set([symbol,...correlated])].reduce((n,s)=>n+(exposure.bySymbol[s]||0),0);
  const dollars=Math.max(0,Math.min(
    equity*cfg.maxGrossExposurePct/100-exposure.gross,
    equity*cfg.maxPositionEquityPct/100-(exposure.bySymbol[symbol]||0),
    equity*cfg.maxCorrelatedExposurePct/100-group,
    // Existing reservations are already reflected in broker cash/buying power;
    // the gross cap is the independent account-wide no-leverage backstop.
    Math.max(0,cash),cfg.maxPositionNotional>0?cfg.maxPositionNotional:Infinity,
  ));
  return {ok:dollars>0,dollars,reason:dollars>0?null:'Exposure, concentration or cash cap reached'};
}
export function correlation(a,b,min=40){
  const returns=bars=>new Map(bars.slice(1).map((v,i)=>[bars[i].date+':'+v.date,v.close>0&&bars[i].close>0?v.close/bars[i].close-1:NaN]));
  const x=returns(a),y=returns(b),pairs=[...x].filter(([d,r])=>Number.isFinite(r)&&Number.isFinite(y.get(d))).map(([d,r])=>[r,y.get(d)]).slice(-60);
  if(pairs.length<min)return null;
  const mx=pairs.reduce((n,p)=>n+p[0],0)/pairs.length,my=pairs.reduce((n,p)=>n+p[1],0)/pairs.length;
  let xy=0,xx=0,yy=0;for(const [u,v] of pairs){xy+=(u-mx)*(v-my);xx+=(u-mx)**2;yy+=(v-my)**2;}
  return xx>0&&yy>0?xy/Math.sqrt(xx*yy):null;
}
