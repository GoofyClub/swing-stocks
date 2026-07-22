// =============================================================================
// Markets, watchlists, and sector configuration.
// VERBATIM extraction from /legacy/swing_terminal_4-1.html (lines 2999–3177).
// =============================================================================

// ----- Curated watchlist with structural reasoning -----
// Each ticker has been picked because it CHRONICALLY satisfies the
// framework's structural prerequisites (index membership, liquidity,
// market cap, large float). Whether it qualifies on a given day still
// depends on its current trend, sector rank, and setup conditions.
export const STARTER_WATCHLIST = [
  // === Technology (XLK) — most frequent source of pullback continuations ===
  { t: 'AAPL',  s: 'XLK', why: 'Apple. ~$3T cap, dual SP500/NDX100, top-5 daily dollar volume in US equities. Trades smoothly with low spread, well-behaved 20-EMA respect.' },
  { t: 'MSFT',  s: 'XLK', why: 'Microsoft. Mega-cap with cloud/AI tailwind. Historically high win-rate on 20-EMA pullback continuations during bull regimes.' },
  { t: 'NVDA',  s: 'XLK', why: 'NVIDIA. AI infrastructure leader. High ATR means larger R-multiples but framework sizing scales accordingly.' },
  { t: 'AVGO',  s: 'XLK', why: 'Broadcom. Semiconductor + software, very high liquidity. Clean trends post-VMware integration.' },
  { t: 'AMD',   s: 'XLK', why: 'AMD. High-beta semi name. Strong 20-EMA pullback character when chips lead.' },
  { t: 'ORCL',  s: 'XLK', why: 'Oracle. Cloud/AI cap-ex pivot, NDX100 member, cleaner trends than other legacy software.' },
  { t: 'CRM',   s: 'XLK', why: 'Salesforce. Enterprise SaaS leader, well-traded, $200B+ cap.' },
  { t: 'ADBE',  s: 'XLK', why: 'Adobe. Creative SaaS monopoly, NDX100, deep liquidity.' },
  { t: 'NOW',   s: 'XLK', why: 'ServiceNow. Enterprise workflow leader, high RS in tech expansion phases.' },
  { t: 'INTU',  s: 'XLK', why: 'Intuit. Tax + small-business software; defensive earnings cadence.' },
  { t: 'PANW',  s: 'XLK', why: 'Palo Alto Networks. Cyber-security leader, NDX100, big-cap with persistent uptrend bias.' },
  { t: 'CSCO',  s: 'XLK', why: 'Cisco. Lower-beta tech, included for diversification across the XLK basket.' },
  { t: 'TXN',   s: 'XLK', why: 'Texas Instruments. Analog semis, lower volatility, slow steady trends.' },

  // === Communication Services (XLC) ===
  { t: 'GOOGL', s: 'XLC', why: 'Alphabet. ~$2T cap, search + cloud + YouTube; dominant XLC weight.' },
  { t: 'META',  s: 'XLC', why: 'Meta. Ad/AI leader, high RS in tech-led runs.' },
  { t: 'NFLX',  s: 'XLC', why: 'Netflix. Streaming leader; clean trends since 2023 ad-tier turnaround.' },
  { t: 'TMUS',  s: 'XLC', why: 'T-Mobile. Wireless carrier with growth posture; calmer ATR profile.' },

  // === Consumer Discretionary (XLY) ===
  { t: 'AMZN',  s: 'XLY', why: 'Amazon. Top XLY weight, AWS + retail + ads. Mega-cap, deep liquidity.' },
  { t: 'TSLA',  s: 'XLY', why: 'Tesla. Highest-volatility large cap; framework sizing keeps risk capped.' },
  { t: 'HD',    s: 'XLY', why: 'Home Depot. Stable, large cap, clean institutional behavior.' },
  { t: 'MCD',   s: 'XLY', why: "McDonald's. Defensive consumer, calmer ATR." },
  { t: 'BKNG',  s: 'XLY', why: 'Booking Holdings. Travel platform; high price means smaller share count, framework sizing handles it.' },
  { t: 'LOW',   s: 'XLY', why: "Lowe's. Home-improvement #2, correlated to HD." },

  // === Health Care (XLV) ===
  { t: 'LLY',   s: 'XLV', why: 'Eli Lilly. GLP-1 leader, sustained uptrend phases, low headline risk between earnings.' },
  { t: 'UNH',   s: 'XLV', why: 'UnitedHealth. ~$500B cap, top XLV weight; subject to regulatory headlines so check news daily.' },
  { t: 'JNJ',   s: 'XLV', why: 'Johnson & Johnson. Defensive blue-chip, low ATR.' },
  { t: 'ABBV',  s: 'XLV', why: 'AbbVie. Large pharma with stable trend behavior.' },
  { t: 'ISRG',  s: 'XLV', why: 'Intuitive Surgical. Med-device leader, NDX100, clean continuation patterns.' },
  { t: 'TMO',   s: 'XLV', why: 'Thermo Fisher. Life-science tools; institutional favorite.' },
  { t: 'MRK',   s: 'XLV', why: 'Merck. Diversified pharma, calmer ATR.' },
  { t: 'REGN',  s: 'XLV', why: 'Regeneron. Biotech with cleaner trend behavior than most peers.' },

  // === Financials (XLF) ===
  { t: 'JPM',   s: 'XLF', why: 'JPMorgan. Top XLF weight, highest-quality bank; benchmark for sector.' },
  { t: 'BAC',   s: 'XLF', why: 'Bank of America. Rate-sensitive money-center bank.' },
  { t: 'WFC',   s: 'XLF', why: 'Wells Fargo. Domestic-focused bank, post-asset-cap recovery story.' },
  { t: 'GS',    s: 'XLF', why: 'Goldman Sachs. Investment bank, higher beta within financials.' },
  { t: 'V',     s: 'XLF', why: 'Visa. Payments network, lower-volatility XLF name.' },
  { t: 'MA',    s: 'XLF', why: 'Mastercard. Payments duopoly with V.' },
  { t: 'AXP',   s: 'XLF', why: 'American Express. Premium consumer credit; closely watched.' },
  { t: 'BLK',   s: 'XLF', why: 'BlackRock. Asset manager #1; lower volatility, AUM-linked.' },

  // === Industrials (XLI) ===
  { t: 'GE',    s: 'XLI', why: 'GE Aerospace. Post-spinoff focus, strong post-2023 trend.' },
  { t: 'BA',    s: 'XLI', why: 'Boeing. Higher headline risk; included for sector diversity.' },
  { t: 'CAT',   s: 'XLI', why: 'Caterpillar. Construction/mining cycle bellwether.' },
  { t: 'RTX',   s: 'XLI', why: 'RTX Corp. Defense + aero, large cap, calm trends.' },
  { t: 'LMT',   s: 'XLI', why: 'Lockheed Martin. Defense pure-play, low-beta.' },
  { t: 'HON',   s: 'XLI', why: 'Honeywell. Diversified industrial, clean institutional behavior.' },

  // === Energy (XLE) ===
  { t: 'XOM',   s: 'XLE', why: 'Exxon Mobil. Top XLE weight, integrated oil major.' },
  { t: 'CVX',   s: 'XLE', why: 'Chevron. #2 integrated oil; correlated to XOM.' },

  // === Consumer Staples (XLP) ===
  { t: 'COST',  s: 'XLP', why: 'Costco. NDX100 member, retailer with persistent uptrend; rare staple in tech-led runs.' },
  { t: 'WMT',   s: 'XLP', why: 'Walmart. Mega-cap retailer, calm trend behavior.' },
  { t: 'PG',    s: 'XLP', why: "P&G. Consumer staple core, low volatility." },
  { t: 'KO',    s: 'XLP', why: 'Coca-Cola. Defensive blue-chip, low ATR.' }
];

export const SECTOR_ETFS = ['XLK', 'XLV', 'XLF', 'XLY', 'XLC', 'XLI', 'XLP', 'XLE', 'XLU', 'XLB', 'XLRE'];

// Curated large-cap universe — the hand-picked US starter names. A signal on any
// of these tickers is tagged `largeCap:true`, powering the "Large Cap" filter on
// Live Signals / History / Automation (independent of, and overlapping with, the
// sp500 index tag). Sourced from STARTER_WATCHLIST so the curated set stays in
// one place.
export const LARGE_CAP_TICKERS = new Set(STARTER_WATCHLIST.map(x => x.t));

// Human-readable names for the sector codes stored on each signal (US SPDR
// sector ETFs + the NSE sector indices used for India). Used wherever we show
// a SECTOR column so users see "Technology" instead of the raw "XLK" tag.
export const SECTOR_NAMES = {
  // US — SPDR select-sector ETFs
  XLK: 'Technology', XLV: 'Health Care', XLF: 'Financials', XLY: 'Consumer Discretionary',
  XLC: 'Communication Services', XLI: 'Industrials', XLP: 'Consumer Staples', XLE: 'Energy',
  XLU: 'Utilities', XLB: 'Materials', XLRE: 'Real Estate',
  // India — NSE sector indices
  '^CNXIT': 'IT', '^NSEBANK': 'Banking', '^CNXFMCG': 'FMCG', '^CNXPHARMA': 'Pharma',
  '^CNXAUTO': 'Auto', '^CNXENERGY': 'Energy', '^CNXMETAL': 'Metal', '^CNXINFRA': 'Infrastructure',
};

// Maps a stored sector code to its display name, falling back to the raw code
// (so an unmapped/new sector still shows something rather than a blank cell).
export function sectorName(code) {
  if (!code) return '';
  return SECTOR_NAMES[code] || code;
}

export const STARTER_WATCHLIST_INDIA = [
  // NIFTY 50 — 48 stocks across 8 NSE sector indices (stored without .NS; yahooSymbol() appends it)
  // IT — ^CNXIT
  { t: 'TCS',        s: '^CNXIT',     why: 'Tata Consultancy Services. Largest Indian IT exporter, bellwether for sector.' },
  { t: 'INFY',       s: '^CNXIT',     why: 'Infosys. Second-largest IT, global delivery model, consistent earnings.' },
  { t: 'HCLTECH',    s: '^CNXIT',     why: 'HCL Technologies. Strong in infrastructure services and engineering.' },
  { t: 'TECHM',      s: '^CNXIT',     why: 'Tech Mahindra. Telecom-IT specialist, digital transformation play.' },
  { t: 'LTIM',       s: '^CNXIT',     why: 'LTIMindtree. Large-cap IT mid-tier, accelerating growth.' },
  { t: 'WIPRO',      s: '^CNXIT',     why: 'Wipro. Diversified IT services, restructured for growth.' },
  // Banking & Finance — ^NSEBANK
  { t: 'HDFCBANK',   s: '^NSEBANK',   why: 'HDFC Bank. Largest private bank, gold standard for asset quality.' },
  { t: 'ICICIBANK',  s: '^NSEBANK',   why: 'ICICI Bank. Second-largest private bank, strong retail franchise.' },
  { t: 'KOTAKBANK',  s: '^NSEBANK',   why: 'Kotak Mahindra Bank. Premium franchise, high ROE.' },
  { t: 'SBIN',       s: '^NSEBANK',   why: 'State Bank of India. Largest PSU bank, massive branch network.' },
  { t: 'AXISBANK',   s: '^NSEBANK',   why: 'Axis Bank. Turnaround story, improving credit quality.' },
  { t: 'INDUSINDBK', s: '^NSEBANK',   why: 'IndusInd Bank. Micro-finance + vehicle finance franchise.' },
  { t: 'BAJFINANCE', s: '^NSEBANK',   why: 'Bajaj Finance. Premier consumer NBFC, high-growth lending.' },
  { t: 'BAJAJFINSV', s: '^NSEBANK',   why: 'Bajaj Finserv. Financial services conglomerate, insurance + lending.' },
  // FMCG — ^CNXFMCG
  { t: 'HINDUNILVR', s: '^CNXFMCG',   why: 'Hindustan Unilever. FMCG blue-chip, dominant distribution.' },
  { t: 'ITC',        s: '^CNXFMCG',   why: 'ITC. Tobacco + FMCG + hotels conglomerate, high dividend yield.' },
  { t: 'NESTLEIND',  s: '^CNXFMCG',   why: 'Nestle India. Maggi noodles, premium packaged foods.' },
  { t: 'BRITANNIA',  s: '^CNXFMCG',   why: 'Britannia Industries. Biscuits & bakery leader.' },
  { t: 'TATACONSUM', s: '^CNXFMCG',   why: 'Tata Consumer Products. Tata Tea + Starbucks India growth.' },
  // Pharma & Healthcare — ^CNXPHARMA
  { t: 'SUNPHARMA',  s: '^CNXPHARMA', why: 'Sun Pharma. Largest Indian pharma, strong US + India generics.' },
  { t: 'DRREDDY',    s: '^CNXPHARMA', why: "Dr Reddy's. Generics exporter, API integration." },
  { t: 'CIPLA',      s: '^CNXPHARMA', why: 'Cipla. Respiratory specialist, branded generics.' },
  { t: 'DIVISLAB',   s: '^CNXPHARMA', why: "Divi's Laboratories. API manufacturer, export-focused." },
  { t: 'APOLLOHOSP', s: '^CNXPHARMA', why: 'Apollo Hospitals. Premier hospital chain, healthcare platform.' },
  // Automobiles — ^CNXAUTO
  { t: 'MARUTI',     s: '^CNXAUTO',   why: 'Maruti Suzuki. Largest passenger car maker in India.' },
  { t: 'M&M',        s: '^CNXAUTO',   why: 'Mahindra & Mahindra. SUV leader, EV transition story.' },
  { t: 'TATAMOTORS', s: '^CNXAUTO',   why: 'Tata Motors. JLR premium + domestic EV leadership.' },
  { t: 'EICHERMOT',  s: '^CNXAUTO',   why: 'Eicher Motors. Royal Enfield motorcycles, premium niche.' },
  { t: 'HEROMOTOCO', s: '^CNXAUTO',   why: 'Hero MotoCorp. World largest two-wheeler maker.' },
  { t: 'BAJAJ-AUTO', s: '^CNXAUTO',   why: 'Bajaj Auto. Premium motorcycles + 3-wheelers, export leader.' },
  // Energy & Power — ^CNXENERGY
  { t: 'RELIANCE',   s: '^CNXENERGY', why: 'Reliance Industries. O&G + Jio telecom + retail conglomerate.' },
  { t: 'ONGC',       s: '^CNXENERGY', why: "ONGC. India's largest oil & gas producer, PSU dividend." },
  { t: 'BPCL',       s: '^CNXENERGY', why: 'BPCL. Downstream refining + retail fuel network.' },
  { t: 'NTPC',       s: '^CNXENERGY', why: 'NTPC. Largest power generator, renewables expansion.' },
  { t: 'POWERGRID',  s: '^CNXENERGY', why: 'Power Grid Corp. Regulated transmission monopoly.' },
  { t: 'COALINDIA',  s: '^CNXENERGY', why: 'Coal India. World largest coal miner, high dividend yield.' },
  // Metals — ^CNXMETAL
  { t: 'TATASTEEL',  s: '^CNXMETAL',  why: 'Tata Steel. Integrated steelmaker, Europe + India operations.' },
  { t: 'HINDALCO',   s: '^CNXMETAL',  why: 'Hindalco. Aluminium + copper, Novelis global downstream.' },
  { t: 'JSWSTEEL',   s: '^CNXMETAL',  why: 'JSW Steel. Fast-growing private steel, capacity expansion.' },
  // Infra, Cement & Conglomerate — ^CNXINFRA
  { t: 'LT',         s: '^CNXINFRA',  why: 'Larsen & Toubro. Diversified engineering & construction giant.' },
  { t: 'ADANIPORTS', s: '^CNXINFRA',  why: 'Adani Ports. Largest port operator in India by cargo.' },
  { t: 'ADANIENT',   s: '^CNXINFRA',  why: 'Adani Enterprises. Incubator for Adani group businesses.' },
  { t: 'GRASIM',     s: '^CNXINFRA',  why: 'Grasim Industries. Cement + paints (Birla Opus) conglomerate.' },
  { t: 'ULTRACEMCO', s: '^CNXINFRA',  why: "UltraTech Cement. India's largest cement company." },
  { t: 'TITAN',      s: '^CNXINFRA',  why: 'Titan Company. Watches + jewellery (Tanishq), aspirational brand.' },
  { t: 'SHRIRAMFIN', s: '^CNXINFRA',  why: 'Shriram Finance. Vehicle financing NBFC, semi-urban focus.' },
  { t: 'HDFCLIFE',   s: '^CNXINFRA',  why: 'HDFC Life Insurance. Life insurance leader, private sector.' },
  { t: 'SBILIFE',    s: '^CNXINFRA',  why: 'SBI Life Insurance. Second-largest life insurer, bancassurance.' },
];

export const SECTOR_ETFS_INDIA = ['^CNXIT', '^NSEBANK', '^CNXFMCG', '^CNXPHARMA', '^CNXAUTO', '^CNXENERGY', '^CNXMETAL', '^CNXINFRA'];

// ----- Broader universe (opt-in) ------------------------------------------
// The core lists above are tuned for MEAN-REVERSION (liquid blue chips). The
// breakout/momentum strategies (52WH, VCP, HTF, Pocket Pivot) need a wider net
// of mid/large-cap growth & momentum names to find real new-high leaders. These
// EXTRA names are appended to the core list to form the "broad" set. Switch
// which set the cron scans with the WATCHLIST_SET env/repo variable
// ('core' | 'broad', default 'core'). This is a STARTER broad list — expand it
// toward the full S&P 500 / NIFTY 200 from an official constituents source.
const BROAD_EXTRA_US = [
  // Tech / semis / software (XLK)
  { t: 'PLTR', s: 'XLK', name: 'Palantir' }, { t: 'CRWD', s: 'XLK', name: 'CrowdStrike' },
  { t: 'FTNT', s: 'XLK', name: 'Fortinet' }, { t: 'ANET', s: 'XLK', name: 'Arista Networks' },
  { t: 'MRVL', s: 'XLK', name: 'Marvell' }, { t: 'MU', s: 'XLK', name: 'Micron' },
  { t: 'AMAT', s: 'XLK', name: 'Applied Materials' }, { t: 'LRCX', s: 'XLK', name: 'Lam Research' },
  { t: 'KLAC', s: 'XLK', name: 'KLA Corp' }, { t: 'SNPS', s: 'XLK', name: 'Synopsys' },
  { t: 'CDNS', s: 'XLK', name: 'Cadence' }, { t: 'DELL', s: 'XLK', name: 'Dell' },
  { t: 'SNOW', s: 'XLK', name: 'Snowflake' }, { t: 'DDOG', s: 'XLK', name: 'Datadog' },
  { t: 'NET', s: 'XLK', name: 'Cloudflare' }, { t: 'ZS', s: 'XLK', name: 'Zscaler' },
  { t: 'NXPI', s: 'XLK', name: 'NXP Semiconductors' }, { t: 'MCHP', s: 'XLK', name: 'Microchip' },
  // Consumer discretionary (XLY)
  { t: 'UBER', s: 'XLY', name: 'Uber' }, { t: 'ABNB', s: 'XLY', name: 'Airbnb' },
  { t: 'SHOP', s: 'XLY', name: 'Shopify' }, { t: 'CMG', s: 'XLY', name: 'Chipotle' },
  { t: 'LULU', s: 'XLY', name: 'Lululemon' }, { t: 'NKE', s: 'XLY', name: 'Nike' },
  { t: 'SBUX', s: 'XLY', name: 'Starbucks' }, { t: 'MAR', s: 'XLY', name: 'Marriott' },
  { t: 'ORLY', s: 'XLY', name: "O'Reilly Auto" }, { t: 'RCL', s: 'XLY', name: 'Royal Caribbean' },
  // Communication (XLC)
  { t: 'DIS', s: 'XLC', name: 'Disney' }, { t: 'SPOT', s: 'XLC', name: 'Spotify' },
  { t: 'TTD', s: 'XLC', name: 'The Trade Desk' }, { t: 'PINS', s: 'XLC', name: 'Pinterest' },
  // Health care (XLV)
  { t: 'VRTX', s: 'XLV', name: 'Vertex Pharma' }, { t: 'GILD', s: 'XLV', name: 'Gilead' },
  { t: 'DXCM', s: 'XLV', name: 'Dexcom' }, { t: 'ZTS', s: 'XLV', name: 'Zoetis' },
  { t: 'IDXX', s: 'XLV', name: 'Idexx Labs' }, { t: 'HCA', s: 'XLV', name: 'HCA Healthcare' },
  // Financials (XLF)
  { t: 'SCHW', s: 'XLF', name: 'Charles Schwab' }, { t: 'MS', s: 'XLF', name: 'Morgan Stanley' },
  { t: 'SPGI', s: 'XLF', name: 'S&P Global' }, { t: 'ICE', s: 'XLF', name: 'Intercontinental Exch' },
  { t: 'CME', s: 'XLF', name: 'CME Group' }, { t: 'PGR', s: 'XLF', name: 'Progressive' },
  // Industrials (XLI)
  { t: 'DE', s: 'XLI', name: 'Deere' }, { t: 'ETN', s: 'XLI', name: 'Eaton' },
  { t: 'UNP', s: 'XLI', name: 'Union Pacific' }, { t: 'UPS', s: 'XLI', name: 'UPS' },
  { t: 'GD', s: 'XLI', name: 'General Dynamics' }, { t: 'NOC', s: 'XLI', name: 'Northrop Grumman' },
  // Energy (XLE)
  { t: 'SLB', s: 'XLE', name: 'Schlumberger' }, { t: 'EOG', s: 'XLE', name: 'EOG Resources' },
  { t: 'COP', s: 'XLE', name: 'ConocoPhillips' }, { t: 'OXY', s: 'XLE', name: 'Occidental' },
  // Materials (XLB)
  { t: 'FCX', s: 'XLB', name: 'Freeport-McMoRan' }, { t: 'NUE', s: 'XLB', name: 'Nucor' },
  { t: 'LIN', s: 'XLB', name: 'Linde' }, { t: 'SHW', s: 'XLB', name: 'Sherwin-Williams' },
  // Staples / utilities / real estate
  { t: 'PEP', s: 'XLP', name: 'PepsiCo' }, { t: 'MDLZ', s: 'XLP', name: 'Mondelez' },
  { t: 'NEE', s: 'XLU', name: 'NextEra Energy' }, { t: 'PLD', s: 'XLRE', name: 'Prologis' },
];
const BROAD_EXTRA_INDIA = [
  { t: 'COFORGE',    s: '^CNXIT',     name: 'Coforge' },
  { t: 'PERSISTENT', s: '^CNXIT',     name: 'Persistent Systems' },
  { t: 'BANKBARODA', s: '^NSEBANK',   name: 'Bank of Baroda' },
  { t: 'PNB',        s: '^NSEBANK',   name: 'Punjab National Bank' },
  { t: 'IDFCFIRSTB', s: '^NSEBANK',   name: 'IDFC First Bank' },
  { t: 'LUPIN',      s: '^CNXPHARMA', name: 'Lupin' },
  { t: 'AUROPHARMA', s: '^CNXPHARMA', name: 'Aurobindo Pharma' },
  { t: 'BIOCON',     s: '^CNXPHARMA', name: 'Biocon' },
  { t: 'TVSMOTOR',   s: '^CNXAUTO',   name: 'TVS Motor' },
  { t: 'ASHOKLEY',   s: '^CNXAUTO',   name: 'Ashok Leyland' },
  { t: 'GAIL',       s: '^CNXENERGY', name: 'GAIL' },
  { t: 'IOC',        s: '^CNXENERGY', name: 'Indian Oil' },
  { t: 'TATAPOWER',  s: '^CNXENERGY', name: 'Tata Power' },
  { t: 'VEDL',       s: '^CNXMETAL',  name: 'Vedanta' },
  { t: 'SAIL',       s: '^CNXMETAL',  name: 'SAIL' },
  { t: 'DLF',        s: '^CNXINFRA',  name: 'DLF' },
  { t: 'SIEMENS',    s: '^CNXINFRA',  name: 'Siemens India' },
  { t: 'PIDILITIND', s: '^CNXINFRA',  name: 'Pidilite' },
  { t: 'DABUR',      s: '^CNXFMCG',   name: 'Dabur' },
  { t: 'MARICO',     s: '^CNXFMCG',   name: 'Marico' },
];

export const WATCHLIST_BROAD       = [...STARTER_WATCHLIST,       ...BROAD_EXTRA_US];
export const WATCHLIST_BROAD_INDIA = [...STARTER_WATCHLIST_INDIA, ...BROAD_EXTRA_INDIA];

// India NIFTY 50 constituents — the curated core India watchlist IS the NIFTY 50
// set. A signal on any of these is tagged `index:'nifty50'`, powering the India
// index filter (India has no S&P buckets — its indices are Nifty-based). The
// broad extras (BROAD_EXTRA_INDIA) are deliberately excluded: they're a curated
// mix, not official NIFTY 50 members. Kept as a Set for O(1) membership at scan.
export const NIFTY50_TICKERS = new Set(STARTER_WATCHLIST_INDIA.map(x => x.t));

// Pick the watchlist for a market + set. set: 'core' (default) | 'broad'.
export function watchlistFor(market, set = 'core') {
  const broad = String(set).toLowerCase() === 'broad';
  if (market === 'INDIA') return broad ? WATCHLIST_BROAD_INDIA : STARTER_WATCHLIST_INDIA;
  return broad ? WATCHLIST_BROAD : STARTER_WATCHLIST;
}

export const MARKET_CONFIGS = {
  US: {
    indexTicker:    'SPY',
    vixTicker:      '^VIX',
    indexLabel:     'SPY',
    vixLabel:       'VIX',
    sectorEtfs:     SECTOR_ETFS,
    sectorNames:    { XLK: 'Technology', XLV: 'Health Care', XLF: 'Financials', XLY: 'Consumer Discretionary', XLC: 'Communication Services', XLI: 'Industrials', XLP: 'Consumer Staples', XLE: 'Energy', XLU: 'Utilities', XLB: 'Materials', XLRE: 'Real Estate' },
    minPrice:       20,
    maxPrice:       1500,
    minAdv:         20_000_000,
    currencySymbol: '$',
    vixThreshold:   25,
    vixPanic:       28,
    yahooSuffix:    '',
    stooqSuffix:    '.us',
    breadthLabel:   'Breadth (MMFI > 50%)',
    testTicker:     'SPY',
    starterWatchlist: null, // assigned below
  },
  INDIA: {
    indexTicker:    '^NSEI',
    vixTicker:      '^INDIAVIX',
    indexLabel:     'NIFTY 50',
    vixLabel:       'India VIX',
    sectorEtfs:     SECTOR_ETFS_INDIA,
    sectorNames:    { '^CNXIT': 'Information Technology', '^NSEBANK': 'Banking & Finance', '^CNXFMCG': 'FMCG', '^CNXPHARMA': 'Pharma & Healthcare', '^CNXAUTO': 'Automobiles', '^CNXENERGY': 'Energy & Power', '^CNXMETAL': 'Metals', '^CNXINFRA': 'Infra, Cement & Consumer' },
    minPrice:       50,
    maxPrice:       100000,
    minAdv:         500_000_000,
    currencySymbol: '₹',
    vixThreshold:   20,
    vixPanic:       25,
    yahooSuffix:    '.NS',
    stooqSuffix:    '.in',
    breadthLabel:   'Breadth (MMFI > 50%)',
    testTicker:     '^NSEI',
    starterWatchlist: STARTER_WATCHLIST_INDIA,
  },
};
MARKET_CONFIGS.US.starterWatchlist = STARTER_WATCHLIST;

// Extract the human company name from a watchlist entry. The `why` text follows
// the convention "<Name>. <rationale>", so the name is everything before the
// first period. Falls back to the ticker if the convention is broken.
export function companyName(item) {
  if (!item) return '';
  if (item.name) return item.name;
  const why = item.why || '';
  const i = why.indexOf('.');
  if (i > 0) return why.slice(0, i).trim();
  return item.t || '';
}

// Lookup map: ticker -> company name. Built once from the starter watchlists.
const _nameByTicker = new Map();
for (const item of [...WATCHLIST_BROAD, ...WATCHLIST_BROAD_INDIA]) {
  _nameByTicker.set(item.t, companyName(item));
}

// Returns the company name for a ticker, or null if unknown. Caller decides
// fallback (typically "—" so columns alignment but doesn't lie). Consults:
//   1. Curated starter watchlists (~100 names, full whys)
//   2. Popular US large-cap map (~200 more names, top-mover candidates)
//   3. null  ← deliberate, so callers don't accidentally display tickers
//             pretending to be company names
export function nameForTicker(ticker) {
  if (!ticker) return null;
  const direct = _nameByTicker.get(ticker);
  if (direct) return direct;
  // Lazy-load popular-names to keep markets.js focused on market metadata.
  // (Static import would create a circular reference risk with watchlist.js.)
  try {
    // Tree-shake-friendly synchronous import via require-style isn't available
    // in ESM. We do an eager top-of-module import below.
  } catch {}
  return _popularName(ticker);
}

// Eager-loaded popular-name resolver, swapped in at module init via a small
// shim so the function above can reference it without circular dep.
let _popularName = () => null;

// Wire in the popular-names resolver at module init. Doing it here (after
// the export above) keeps the top of the file focused on market metadata
// without forcing a circular import.
import { popularName as _popularNameImpl } from './popular-names.js';
_popularName = _popularNameImpl;

// Default data source priority order, top-down. Override per-deployment in fetchers config.
export const DATA_SOURCE_ORDER = [
  'alpaca',           // US: reliable from datacenter IPs (cron); needs key+secret
  'alphavantage',     // most reliable when a key is set (CSV, native CORS)
  'finnhub',          // also CORS-friendly; candle endpoint coverage varies
  'yahoo_v7_direct',  // Yahoo Finance v7 CSV — most stable free endpoint, no key
  'yahoo_v7_proxy',   // Yahoo Finance v7 CSV via corsproxy.io
  'yahoo_direct',     // Yahoo Finance v8 JSON direct
  'yahoo_query2',     // Yahoo Finance v8 via query2 server
  'yahoo_corsproxy',  // Yahoo Finance v8 via corsproxy.io
  'stooq_direct',     // stooq.com (CORS blocked on most networks)
  'stooq_corsproxy',
  'stooq_allorigins',
  'stooq_codetabs',
];
