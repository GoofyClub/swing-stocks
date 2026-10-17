// Shared defaults for the existing UI and the single-account local bot.
export const DEFAULT_AUTOMATION = {
  enabled: false,            // master switch — OFF until the user opts in
  mode: 'paper',             // 'paper' | 'live'

  // --- Broker connection ---
  broker: 'alpaca',          // 'alpaca' | 'zerodha' | 'dhan' | 'other'
  restApiBase: 'https://paper-api.alpaca.markets',
  apiKey: '',
  apiSecret: '',

  // --- Signal selection ---
  markets: ['US'],           // which markets to auto-trade
  tiers: ['A+'],             // A+ / Tier 1 / Tier 2
  strategies: [],            // strategyKey allow-list; [] = all strategies
  indexes: [],               // global index allow-list (sp500/sp400/sp600); [] = all
  strategyIndexes: {},       // per-strategy index override: { strategyKey: ['sp500',...] } — overrides `indexes` for that strategy
  sides: ['buy'],

  // --- Scheduling ---
  tradeDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  respectRegime: true,       // block new longs when the market regime is risk-off

  // --- Universe filters ---
  excludeTickers: [],        // never auto-trade these symbols
  minPrice: 20,              // skip signals priced below this
  maxPrice: 1500,            // skip signals priced above this
  minAdvUsd: 20_000_000,     // liquidity floor (20d avg dollar volume)

  // --- Risk & sizing ---
  sizingMode: 'risk',        // 'risk' (% of equity) | 'fixed' ($ per trade)
  riskPerTradePct: 0.5,      // [risk mode] % of equity risked per trade (off SL distance)
  fixedNotional: 100,        // [fixed mode] $ to deploy per trade
  maxPositionNotional: 0,    // hard $ cap per position (0 = no cap), both modes
  maxConcurrentPositions: 8,
  maxPositionsPerSector: 2,
  maxPortfolioHeatPct: 4,    // cap on summed open risk across all positions
  dailyLossHaltPct: 3,       // halt new entries after this daily drawdown
  maxDrawdownHaltPct: 20,    // halt new entries when equity is this far below its peak (0 = off)
  slippageBudgetPct: 0.3,    // skip if live price ran past entry by more than this

  updatedAt: null,
};
