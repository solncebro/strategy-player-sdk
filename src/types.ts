export type ParamValue = number | string | boolean;

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MaValues {
  ma25: number;
  ma50: number;
  ma100: number;
  ma200: number;
  ma99?: number | null;
  ma1000?: number | null;
}

export interface PositionOptions {
  stopLoss?: number;
  takeProfit?: number;
  tag?: string;
}

export interface Position {
  id: string;
  side: "long" | "short";
  entryPrice: number;
  size: number;
  entryTime: number;
  stopLoss?: number;
  takeProfit?: number;
  tag?: string;
  pnl: number;
  runningBest: number;
}

export interface PendingOrder {
  id: string;
  side: "buy" | "sell";
  type: "limit" | "stop";
  price: number;
  amount: number;
  createdAtBar: number;
}

export interface FilledOrder {
  id: string;
  side: "buy" | "sell";
  type: "limit" | "stop" | "market";
  price: number;
  amount: number;
  fillTime: number;
  positionId: string | null;
  entryPrice?: number;
  runningBest?: number;
  // The bar during which the order PHYSICALLY filled, supplied by the live engine from the forming
  // kline. In live a limit fills mid-forming-bar while the runner's currentBar is the previous CLOSED
  // bar, so getCurrentBar() is off by one — a strategy that snapshots the entry candle (e.g. an
  // entry-kline guard) must prefer these. Absent in backtest/paper (fills are intra-bar, so
  // getCurrentBar() already IS the fill bar) → consumers fall back to getCurrentBar().
  fillBarOpenTimestamp?: number;
  fillBarHigh?: number;
  fillBarLow?: number;
}

export interface FundingRate {
  time: number;
  rate: number;
}

export interface Trade {
  positionId: string;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  pnlPercent: number;
  entryTime: number;
  exitTime: number;
  stopLoss?: number;
  takeProfit?: number;
  exitReason: string;
  tag?: string;
  commission: number;
  funding: number;
  netPnl: number;
  /**
   * Strategy-provided, display-ready values for the strategy's declared
   * `backtestColumns` (set via `setPositionDisplay`). Keys match column `key`
   * / `tooltipKey`. Values are already-formatted strings, or a
   * `BacktestTooltip` for tooltip cells.
   */
  display?: Record<string, unknown>;
}

/** A strategy-declared extra column in the backtest results table. */
export interface BacktestColumnSpec {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
  /** If set, the cell shows an info marker; `Trade.display[tooltipKey]` holds a `BacktestTooltip`. */
  tooltipKey?: string;
}

export interface BacktestTooltipRow {
  label: string;
  /** Already-formatted actual value at the trade moment (e.g. "+12.3%", "2.0B"). */
  value: string;
  /** Configured ranges (already formatted); `matched` marks the one the value fell into. */
  ranges: { text: string; matched: boolean }[];
}

export interface BacktestTooltip {
  rows: BacktestTooltipRow[];
}

export type AuxSeriesKind = "oi" | "liqLong" | "liqShort" | "lsr";

/**
 * One open-interest candle. Open interest is supplied as a full OHLC candle
 * (not just a single close) so strategies can measure intra-candle growth
 * (`close - open`) and a true ATR of open interest. Values are in coins
 * (base asset), not USD.
 */
export interface OiOhlc {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface AuxSeriesData {
  oiByTime: Map<number, number>;
  liqLongByTime: Map<number, number>;
  liqShortByTime: Map<number, number>;
  lsrByTime: Map<number, number>;
  /**
   * Optional open-interest OHLC series (coins). Additive to `oiByTime`; when
   * present, `getOiOhlc()/getOiOhlcHistory()` read from it.
   */
  oiOhlcByTime?: Map<number, OiOhlc>;
}

export interface BacktestEvent {
  type: string;
  time: number;
  data: Record<string, unknown>;
}

export interface EquityPoint {
  barIndex: number;
  timestamp: number;
  balance: number;
}

export interface CommissionConfig {
  makerRate: number;
  takerRate: number;
}

export interface TimeframeData {
  resolution: string;
  barList: Bar[];
  auxSeriesData?: AuxSeriesData;
}

export interface BacktestContextOptions {
  commission?: CommissionConfig;
  fundingRateList?: FundingRate[];
  params?: Record<string, ParamValue>;
  rawConfig?: Record<string, unknown>;
  auxSeriesData?: AuxSeriesData;
  timeframeDataList?: TimeframeData[];
  /**
   * When false, funding rates are still readable by the strategy
   * (getCurrentFundingRate / getRecentFundingRates) but their cost is NOT
   * charged to position PnL. Defaults to true (cost applied).
   */
  applyFundingCost?: boolean;
}

export interface BacktestContextResult {
  tradeList: Trade[];
  equityList: EquityPoint[];
  eventList: BacktestEvent[];
}

export interface BacktestConfig {
  symbol: string;
  resolution: string;
  dateFrom: number;
  dateTo: number;
  initialBalance: number;
  commission?: CommissionConfig;
  useFunding?: boolean;
}

export interface BacktestMetrics {
  totalPnl: number;
  totalPnlPercent: number;
  totalCommission: number;
  totalFunding: number;
  totalNetPnl: number;
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  profitFactor: number | null;
  maxConsecutiveLosses: number;
  avgTradeDuration: number;
}

export type PeriodType = "yearly" | "monthly" | "weekly";

export interface PeriodMetrics {
  label: string;
  dateFrom: number;
  dateTo: number;
  metrics: BacktestMetrics;
  tradeCount: number;
}

export interface PeriodBreakdown {
  yearly: PeriodMetrics[];
  monthly: PeriodMetrics[];
  weekly: PeriodMetrics[];
}

export interface TradingEnv {
  openLong(size: number, options?: PositionOptions): void;
  openShort(size: number, options?: PositionOptions): void;
  closeLong(): void;
  closeShort(): void;

  placeLimitOrder(side: "buy" | "sell", price: number, amount: number): string;
  cancelOrder(orderId: string): boolean;
  cancelAllOrders(): void;
  modifyOrderPrice(orderId: string, newPrice: number): boolean;
  getPendingOrderList(): PendingOrder[];

  getPosition(positionId?: string): Position | null;
  getPositionList(): Position[];
  closePosition(positionId?: string, exitReason?: string): void;
  closeAllPositions(exitReason?: string): void;
  setStopLoss(positionIdOrPrice: string | number, price?: number): void;
  /**
   * Set/replace take-profit on an existing position (mirrors
   * `PositionOptions.takeProfit`); checked next bar before `onBar`, fills at
   * the exact price with taker commission.
   */
  setTakeProfit?(positionId: string, price: number): void;
  setPositionTag(positionId: string, tag: string): void;
  /**
   * Attach display-ready values for the strategy's `backtestColumns` to a
   * position; carried into `Trade.display` on close (mirrors `setPositionTag`).
   */
  setPositionDisplay?(positionId: string, data: Record<string, unknown>): void;

  getBalance(): number;
  getBarIndex(): number;
  getCurrentBar(): Bar;
  getHistory(count: number, resolution?: string): Bar[];

  getOiClose(resolution?: string): number | null;
  /**
   * Current open-interest candle (OHLC, coins) on the active bar, or null when
   * no OHLC open-interest series is loaded. Additive to `getOiClose`.
   */
  getOiOhlc?(resolution?: string): OiOhlc | null;
  /**
   * Last `count` closed open-interest candles (OHLC, coins), oldest→newest.
   * Missing entries are null. Additive to `getAuxHistory("oi", ...)`.
   */
  getOiOhlcHistory?(count: number, resolution?: string): Array<OiOhlc | null>;
  getLiqLongUsd(resolution?: string): number | null;
  getLiqShortUsd(resolution?: string): number | null;
  getLongShortRatio(resolution?: string): number | null;
  getCurrentFundingRate(): number | null;
  getRecentFundingRates(count: number): number[];
  getAuxHistory(series: AuxSeriesKind, count: number, resolution?: string): Array<number | null>;

  getMaValues?(resolution: string): MaValues;
  getVolume24h?(resolution?: string): number | null;

  getParam<T extends ParamValue = ParamValue>(key: string, defaultValue: T): T;
  getConfig(): Record<string, unknown>;
  emitEvent(type: string, data: Record<string, unknown>): void;
}

export interface ParamsValidationResult {
  ok: boolean;
  error?: string;
}

export interface CreateTradingEnvOptions {
  parsedParams: unknown;
  symbol: string;
  resolution: string;
  fundingRateList?: FundingRate[];
}

export interface Strategy {
  name: string;
  version: string;
  params: Record<string, ParamValue>;
  allowedResolutions?: string[];
  requiredTimeframes?: Record<string, number>;
  /**
   * Extra columns this strategy contributes to the backtest results table.
   * Values come from each trade's `display` (set via `setPositionDisplay`).
   * Omitted/empty → no extra columns (only the generic base columns show).
   */
  backtestColumns?: BacktestColumnSpec[];
  validateParams?(parsed: unknown): ParamsValidationResult;
  createTradingEnv?(innerEnv: TradingEnv, options: CreateTradingEnvOptions): TradingEnv;
  init?(env: TradingEnv): void;
  onBar(bar: Bar, maValues: MaValues, env: TradingEnv): void;
  onOrderFill?(order: FilledOrder, env: TradingEnv): void;
  onEnd?(env: TradingEnv): void;
  /**
   * Optional live-trading hooks (ignored by the backtest player): serialize the strategy's internal
   * state so a live runner can persist it and restore it after a restart. A strategy that implements
   * both can resume mid-setup without replaying history.
   */
  getStateSnapshot?(): Record<string, unknown>;
  restoreStateSnapshot?(snapshot: Record<string, unknown>): void;
  /**
   * Optional user-command channel (live/paper runners only — the backtest player never calls it).
   * The runner forwards an external command (e.g. a Telegram reply) to the strategy. Implementations
   * should only mutate snapshot-visible state here and act on it in the next onBar, so behaviour stays
   * deterministic relative to bar boundaries and replays can reproduce it by re-sending the commands.
   */
  onExternalCommand?(command: Record<string, unknown>, env: TradingEnv): void;
}
