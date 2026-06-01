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
}

export type AuxSeriesKind = "oi" | "liqLong" | "liqShort" | "lsr";

export interface AuxSeriesData {
  oiByTime: Map<number, number>;
  liqLongByTime: Map<number, number>;
  liqShortByTime: Map<number, number>;
  lsrByTime: Map<number, number>;
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
  setPositionTag(positionId: string, tag: string): void;

  getBalance(): number;
  getBarIndex(): number;
  getCurrentBar(): Bar;
  getHistory(count: number, resolution?: string): Bar[];

  getOiClose(resolution?: string): number | null;
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
  validateParams?(parsed: unknown): ParamsValidationResult;
  createTradingEnv?(innerEnv: TradingEnv, options: CreateTradingEnvOptions): TradingEnv;
  init?(env: TradingEnv): void;
  onBar(bar: Bar, maValues: MaValues, env: TradingEnv): void;
  onOrderFill?(order: FilledOrder, env: TradingEnv): void;
  onBeforeLimitFill?(maValues: MaValues, env: TradingEnv): boolean;
  onEnd?(env: TradingEnv): void;
}
