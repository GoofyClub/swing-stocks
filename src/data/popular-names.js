// =============================================================================
// Extended ticker → company name map for the US market.
//
// Covers ~200 tickers that frequently appear in Alpha Vantage's top
// gainers/losers/most-active feeds but are NOT in our starter watchlist
// (which only has 53 names). Used by `nameForTicker()` in markets.js so the
// Stocks in Play tab can show real company names instead of falling back to
// tickers.
//
// Not exhaustive by design — only the names that turn up commonly. Anything
// missing gets `—` in the NAME column (better than misleading the user with
// a ticker pretending to be a name).
// =============================================================================

export const POPULAR_NAMES = {
  // --- Mega-cap tech / SaaS not in starter ---
  PLTR:  'Palantir Technologies',
  SHOP:  'Shopify',
  SNOW:  'Snowflake',
  DDOG:  'Datadog',
  ZS:    'Zscaler',
  CRWD:  'CrowdStrike',
  MDB:   'MongoDB',
  NET:   'Cloudflare',
  TEAM:  'Atlassian',
  OKTA:  'Okta',
  SPLK:  'Splunk',
  ABNB:  'Airbnb',
  COIN:  'Coinbase',
  SQ:    'Block (Square)',
  PYPL:  'PayPal',
  EBAY:  'eBay',
  ETSY:  'Etsy',
  ROKU:  'Roku',
  ZM:    'Zoom',
  AFRM:  'Affirm',
  U:     'Unity Software',
  RBLX:  'Roblox',
  TWLO:  'Twilio',
  ASAN:  'Asana',
  GTLB:  'GitLab',
  MNDY:  'Monday.com',
  PATH:  'UiPath',
  BILL:  'BILL Holdings',
  HUBS:  'HubSpot',
  RNG:   'RingCentral',
  DOCU:  'DocuSign',
  WDAY:  'Workday',
  ADSK:  'Autodesk',
  CDNS:  'Cadence Design',
  SNPS:  'Synopsys',
  FTNT:  'Fortinet',
  ANET:  'Arista Networks',
  ARM:   'Arm Holdings',
  RDDT:  'Reddit',
  APP:   'AppLovin',

  // --- Semiconductors ---
  MU:    'Micron Technology',
  AMAT:  'Applied Materials',
  KLAC:  'KLA Corporation',
  LRCX:  'Lam Research',
  MRVL:  'Marvell Technology',
  MCHP:  'Microchip Technology',
  ADI:   'Analog Devices',
  NXPI:  'NXP Semiconductors',
  ON:    'ON Semiconductor',
  MPWR:  'Monolithic Power Systems',
  QCOM:  'Qualcomm',
  TSM:   'Taiwan Semiconductor',
  ASML:  'ASML Holding',
  SMCI:  'Super Micro Computer',
  WOLF:  'Wolfspeed',

  // --- Consumer ---
  SBUX:  'Starbucks',
  NKE:   'Nike',
  LULU:  'Lululemon Athletica',
  CMG:   'Chipotle Mexican Grill',
  DPZ:   "Domino's Pizza",
  YUM:   'Yum! Brands',
  MNST:  'Monster Beverage',
  MDLZ:  'Mondelez International',
  KHC:   'Kraft Heinz',
  HSY:   'Hershey',
  GIS:   'General Mills',
  EL:    'Estée Lauder',
  CL:    'Colgate-Palmolive',
  KMB:   'Kimberly-Clark',
  ULTA:  'Ulta Beauty',
  TJX:   'TJX Companies',
  ROST:  'Ross Stores',
  DG:    'Dollar General',
  DLTR:  'Dollar Tree',
  BBY:   'Best Buy',
  TGT:   'Target',

  // --- Auto / EV / Mobility ---
  F:     'Ford Motor',
  GM:    'General Motors',
  RIVN:  'Rivian Automotive',
  LCID:  'Lucid Group',
  NIO:   'NIO Inc.',
  XPEV:  'XPeng',
  LI:    'Li Auto',
  UBER:  'Uber Technologies',
  LYFT:  'Lyft',

  // --- China ADRs ---
  BABA:  'Alibaba Group',
  BIDU:  'Baidu',
  JD:    'JD.com',
  PDD:   'PDD Holdings',
  NTES:  'NetEase',
  TME:   'Tencent Music',

  // --- Pharma / Biotech ---
  PFE:   'Pfizer',
  GILD:  'Gilead Sciences',
  BIIB:  'Biogen',
  AMGN:  'Amgen',
  BMY:   'Bristol Myers Squibb',
  MDT:   'Medtronic',
  ABT:   'Abbott Laboratories',
  BSX:   'Boston Scientific',
  SYK:   'Stryker',
  EW:    'Edwards Lifesciences',
  DXCM:  'DexCom',
  ALGN:  'Align Technology',
  IDXX:  'IDEXX Laboratories',
  VRTX:  'Vertex Pharmaceuticals',
  MRNA:  'Moderna',
  BNTX:  'BioNTech',
  ZTS:   'Zoetis',
  ELV:   'Elevance Health',
  CI:    'Cigna',
  HUM:   'Humana',
  CVS:   'CVS Health',
  WBA:   'Walgreens Boots Alliance',
  NVO:   'Novo Nordisk',

  // --- Financial ---
  SCHW:  'Charles Schwab',
  MS:    'Morgan Stanley',
  C:     'Citigroup',
  BK:    'Bank of New York Mellon',
  USB:   'U.S. Bancorp',
  PNC:   'PNC Financial Services',
  TFC:   'Truist Financial',
  COF:   'Capital One',
  DFS:   'Discover Financial',
  ALL:   'Allstate',
  MET:   'MetLife',
  PRU:   'Prudential Financial',
  AFL:   'Aflac',
  TRV:   'Travelers',
  AON:   'Aon',
  MMC:   'Marsh & McLennan',
  BX:    'Blackstone',
  KKR:   'KKR & Co.',
  ICE:   'Intercontinental Exchange',
  CME:   'CME Group',
  COIN_ALT: 'Coinbase Global', // alt spelling guard

  // --- Industrial / Aerospace / Defense ---
  UPS:   'United Parcel Service',
  FDX:   'FedEx',
  DAL:   'Delta Air Lines',
  UAL:   'United Airlines',
  AAL:   'American Airlines',
  LUV:   'Southwest Airlines',
  CSX:   'CSX Corporation',
  UNP:   'Union Pacific',
  NSC:   'Norfolk Southern',
  ETN:   'Eaton',
  EMR:   'Emerson Electric',
  ROK:   'Rockwell Automation',
  DE:    'Deere & Company',
  CMI:   'Cummins',
  PCAR:  'PACCAR',
  NOC:   'Northrop Grumman',
  GD:    'General Dynamics',

  // --- Energy ---
  COP:   'ConocoPhillips',
  EOG:   'EOG Resources',
  OXY:   'Occidental Petroleum',
  MPC:   'Marathon Petroleum',
  VLO:   'Valero Energy',
  PSX:   'Phillips 66',
  DVN:   'Devon Energy',
  FANG:  'Diamondback Energy',
  HES:   'Hess Corporation',
  OKE:   'ONEOK',
  KMI:   'Kinder Morgan',
  WMB:   'Williams Companies',
  ET:    'Energy Transfer',
  EPD:   'Enterprise Products Partners',

  // --- REITs ---
  PLD:   'Prologis',
  EQIX:  'Equinix',
  AMT:   'American Tower',
  CCI:   'Crown Castle',
  SPG:   'Simon Property Group',
  O:     'Realty Income',
  VICI:  'VICI Properties',
  IRM:   'Iron Mountain',
  AVB:   'AvalonBay Communities',
  EQR:   'Equity Residential',

  // --- Utilities ---
  NEE:   'NextEra Energy',
  DUK:   'Duke Energy',
  SO:    'Southern Company',
  AEP:   'American Electric Power',
  EXC:   'Exelon',
  XEL:   'Xcel Energy',

  // --- Materials ---
  LIN:   'Linde',
  APD:   'Air Products & Chemicals',
  ECL:   'Ecolab',
  SHW:   'Sherwin-Williams',
  NEM:   'Newmont Corporation',
  FCX:   'Freeport-McMoRan',
  NUE:   'Nucor',
  STLD:  'Steel Dynamics',
  MLM:   'Martin Marietta Materials',
  VMC:   'Vulcan Materials',

  // --- Communication / Media ---
  DIS:   'Walt Disney',
  T:     'AT&T',
  VZ:    'Verizon Communications',
  CMCSA: 'Comcast',
  CHTR:  'Charter Communications',
  EA:    'Electronic Arts',
  TTWO:  'Take-Two Interactive',
  WBD:   'Warner Bros. Discovery',
  PARA:  'Paramount Global',
  NFLX_ALT: 'Netflix', // already in starter, but defensive

  // --- Crypto-related ---
  MSTR:  'MicroStrategy',
  MARA:  'Marathon Digital',
  RIOT:  'Riot Platforms',
  CLSK:  'CleanSpark',
  HUT:   'Hut 8 Mining',
  CIFR:  'Cipher Mining',
  IREN:  'IREN Limited',

  // --- Other popular ---
  BRK_B: 'Berkshire Hathaway B',
  BRKB:  'Berkshire Hathaway B',
  SOFI:  'SoFi Technologies',
  HOOD:  'Robinhood Markets',
  DKNG:  'DraftKings',
  PENN:  'PENN Entertainment',
  CZR:   'Caesars Entertainment',
  WYNN:  'Wynn Resorts',
  MGM:   'MGM Resorts',
  LVS:   'Las Vegas Sands',
  CCL:   'Carnival Corporation',
  RCL:   'Royal Caribbean',
  NCLH:  'Norwegian Cruise Line',
  PINS:  'Pinterest',
  SNAP:  'Snap Inc.',
  SPOT:  'Spotify Technology',
  DASH:  'DoorDash',
  W:     'Wayfair',
  CHWY:  'Chewy',
  RH:    'RH (Restoration Hardware)',
};

// Helper: case-insensitive lookup. Some Alpha Vantage results have lower-case
// or punctuation variants — guard against both.
const _normalized = (() => {
  const m = new Map();
  for (const [k, v] of Object.entries(POPULAR_NAMES)) {
    m.set(k.toUpperCase(), v);
    // Also map common punctuation variants
    m.set(k.replace(/[._-]/g, '').toUpperCase(), v);
  }
  return m;
})();

export function popularName(ticker) {
  if (!ticker) return null;
  const up = String(ticker).toUpperCase();
  return _normalized.get(up) || _normalized.get(up.replace(/[._-]/g, '')) || null;
}
