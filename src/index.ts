export type {
  AuxSeriesData,
  AuxSeriesKind,
  BacktestConfig,
  BacktestContextOptions,
  BacktestContextResult,
  BacktestEvent,
  BacktestMetrics,
  Bar,
  CommissionConfig,
  EquityPoint,
  FilledOrder,
  FundingRate,
  MaValues,
  ParamValue,
  PendingOrder,
  PeriodBreakdown,
  PeriodMetrics,
  PeriodType,
  Position,
  PositionOptions,
  Strategy,
  Trade,
  TradingEnv,
} from "./types";

export type { StrategySpec, TypedTradingEnv } from "./define-strategy";
export { defineStrategy } from "./define-strategy";

export const API_VERSION = "1.0.0";
