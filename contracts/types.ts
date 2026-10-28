/** Independent market-data provider id. Historical field name `exchange` is kept for compatibility: the app never connects to exchanges. */
export type DataSource = "yahoo";
export type Exchange = DataSource;
export type Interval = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
export type Direction = "long" | "short";
export type Verdict = "approve" | "reject" | "abstain";

export interface Candle {
  time: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?: number;
  trades?: number;
}

export interface DerivativesSnapshot {
  markPrice: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  openInterest: number | null;
  openInterestChangePct: number | null;
}

export type CrossCheckStatus = "confirmed" | "warning" | "divergent" | "insufficient" | "unavailable";

export interface SourceCrossCheck {
  status: CrossCheckStatus;
  referenceSource: string | null;
  alignedBars: number;
  medianDeviationPct: number | null;
  maxDeviationPct: number | null;
  detail: string;
}

export interface MarketSnapshot {
  exchange: Exchange;
  symbol: string;
  interval: Interval;
  candles: Candle[];
  higherTimeframes: Partial<Record<Interval, Candle[]>>;
  derivatives: DerivativesSnapshot;
  fetchedAt: number;
  sourceServerTime: number | null;
  isFresh: boolean;
  warnings: string[];
  crossCheck?: SourceCrossCheck;
  /** "spot-index": aggregated spot index price (USD). Perpetual-contract price, funding and open interest are NOT covered. */
  marketType?: "spot-index" | "futures";
  dataQuality?: { volumeZeroPct: number; volumeReliable: boolean };
}

export interface MarketMetrics {
  price: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  atr14: number | null;
  atrPct: number | null;
  adx14: number | null;
  macdHistogram: number | null;
  volumeRatio: number | null;
  realizedVolatilityPct: number | null;
  support: number | null;
  resistance: number | null;
  trend: "bullish" | "bearish" | "range" | "unknown";
  structure: "higher-highs" | "lower-lows" | "mixed" | "unknown";
  higherTrend: "bullish" | "bearish" | "range" | "unknown";
  liquidityUsd: number | null;
  priceChangePct: number | null;
}

export interface RoleReview {
  role: string;
  category: "observer" | "expert";
  method: string;
  dataUsed: string[];
  verdict: Verdict;
  reasonsFor: string[];
  reasonsAgainst: string[];
  limitations: string[];
  reviewedAt: number;
  analysisVersion: string;
}

export interface RiskSettings {
  equity: number;
  riskPerTradePct: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  maxLeverage: number;
  maxPortfolioRiskPct: number;
  maxCorrelatedPositions: number;
  feePct: number;
  slippagePct: number;
  spreadPct: number;
}

export interface RiskAssessment {
  approved: boolean;
  reasons: string[];
  positionSize: number | null;
  notional: number | null;
  riskAmount: number | null;
  leverage: number | null;
  estimatedFees: number | null;
}

export interface Signal {
  id: string;
  symbol: string;
  exchange: Exchange;
  direction: Direction | null;
  status: "approved" | "no-entry" | "invalidated" | "expired";
  entryLow: number | null;
  entryHigh: number | null;
  activation: string;
  issuedAt: number;
  expiresAt: number;
  stopLoss: number | null;
  targets: number[];
  rewardRisk: number | null;
  positionSize: number | null;
  estimatedFunding: number | null;
  evidenceFor: string[];
  evidenceAgainst: string[];
  risk: RiskAssessment;
  reasons: string[];
  analysisVersion: string;
}

export interface AnalysisResult {
  snapshot: MarketSnapshot;
  metrics: MarketMetrics;
  reviews: RoleReview[];
  signal: Signal;
  macro: { available: boolean; safe: boolean; details: string[] };
  strategy: { available: boolean; approved: boolean; details: string[] };
}

export interface BacktestTrade {
  side: Direction;
  signalTime: number;
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number;
  stop: number;
  target: number;
  quantity: number;
  pnl: number;
  fees: number;
  funding: number;
  exitReason: "stop" | "target" | "time" | "liquidation" | "end";
  sample: "train" | "test";
}

export interface BacktestMetrics {
  trades: number;
  winRatePct: number;
  expectancy: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  /** Mark-to-market drawdown including intra-trade adverse excursion (full-run metrics only). */
  maxDrawdownMtmPct?: number;
  averageWin: number;
  averageLoss: number;
  longestLossStreak: number;
  netPnl: number;
  netReturnPct: number;
  totalFees: number;
  totalFunding: number;
}

export interface BacktestResult {
  runId: string;
  createdAt: number;
  symbol: string;
  exchange: Exchange;
  interval: Interval;
  strategyVersion: string;
  parameters: { fast: number; slow: number; atrStop: number; rewardRisk: number; maxHoldingBars: number };
  assumptions: string[];
  biasChecks: { name: string; passed: boolean; detail: string }[];
  metrics: BacktestMetrics;
  outOfSample: BacktestMetrics;
  /** Wilson 95% interval for the out-of-sample win rate, in percent; null when there are no OOS trades. */
  outOfSampleWinRateCI95?: [number, number] | null;
  /** Unlevered buy-and-hold over the same tradable window; not risk-matched to the strategy. */
  baselineBuyHold?: { startTime: number; endTime: number; netReturnPct: number; maxDrawdownPct: number; note: string };
  walkForward: { fold: number; start: number; end: number; metrics: BacktestMetrics }[];
  sensitivity: { parameter: string; value: number; metrics: BacktestMetrics }[];
  equityCurve: { time: number; equity: number; sample: "train" | "test" }[];
  trades: BacktestTrade[];
  robustness: "robust" | "conditional" | "fragile" | "unsupported";
  data: { start: number; end: number; candles: number; fundingPoints: number };
}

export const DEFAULT_RISK: RiskSettings = {
  equity: 10000,
  riskPerTradePct: 0.5,
  maxDailyLossPct: 2,
  maxDrawdownPct: 10,
  maxLeverage: 3,
  maxPortfolioRiskPct: 1.5,
  maxCorrelatedPositions: 1,
  feePct: 0.05,
  slippagePct: 0.02,
  spreadPct: 0.01,
};
