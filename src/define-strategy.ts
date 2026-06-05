import type {
  BacktestColumnSpec,
  Bar,
  CreateTradingEnvOptions,
  FilledOrder,
  MaValues,
  ParamsValidationResult,
  ParamValue,
  Strategy,
  TradingEnv,
} from "./types";

export interface TypedTradingEnv<TParams extends Record<string, ParamValue>> extends TradingEnv {
  getParam<K extends keyof TParams & string>(key: K, defaultValue: TParams[K]): TParams[K];
  getParam<T extends ParamValue = ParamValue>(key: string, defaultValue: T): T;
}

export interface StrategySpec<TParams extends Record<string, ParamValue>> {
  name: string;
  version: string;
  params: TParams;
  allowedResolutions?: string[];
  requiredTimeframes?: Record<string, number>;
  backtestColumns?: BacktestColumnSpec[];
  validateParams?(parsed: unknown): ParamsValidationResult;
  createTradingEnv?(innerEnv: TradingEnv, options: CreateTradingEnvOptions): TradingEnv;
  init?(env: TypedTradingEnv<TParams>): void;
  onBar(bar: Bar, maValues: MaValues, env: TypedTradingEnv<TParams>): void;
  onOrderFill?(order: FilledOrder, env: TypedTradingEnv<TParams>): void;
  onBeforeLimitFill?(maValues: MaValues, env: TypedTradingEnv<TParams>): boolean;
  onEnd?(env: TypedTradingEnv<TParams>): void;
}

export function defineStrategy<TParams extends Record<string, ParamValue>>(
  spec: StrategySpec<TParams>,
): Strategy {
  return spec as unknown as Strategy;
}
