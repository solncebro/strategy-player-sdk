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
  CreateTradingEnvOptions,
  EquityPoint,
  FilledOrder,
  FundingRate,
  MaValues,
  ParamsValidationResult,
  ParamValue,
  PendingOrder,
  PeriodBreakdown,
  PeriodMetrics,
  PeriodType,
  Position,
  PositionOptions,
  Strategy,
  TimeframeData,
  Trade,
  TradingEnv,
} from "./types";

export type { StrategySpec, TypedTradingEnv } from "./define-strategy";
export { defineStrategy } from "./define-strategy";

export const API_VERSION = "1.6.0";
