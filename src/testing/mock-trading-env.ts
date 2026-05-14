import type {
  AuxSeriesData,
  Bar,
  BacktestContextOptions,
  BacktestEvent,
  EquityPoint,
  FundingRate,
  MaValues,
  ParamValue,
  PendingOrder,
  Position,
  Strategy,
  Trade,
} from "../types";
import { StrategyRuntimeContext } from "../runtime/strategy-runtime-context";

export interface MockTradingEnvOptions {
  initialBalance?: number;
  commission?: BacktestContextOptions["commission"];
  fundingRateList?: FundingRate[];
  params?: Record<string, ParamValue>;
  rawConfig?: Record<string, unknown>;
  auxSeriesData?: AuxSeriesData;
}

export interface FeedBarInput {
  bar: Bar;
  maValues: MaValues;
}

export class MockTradingEnv {
  private readonly runtime: StrategyRuntimeContext;
  private readonly strategy: Strategy;
  private initialized = false;

  constructor(strategy: Strategy, options?: MockTradingEnvOptions) {
    const initialBalance = options?.initialBalance ?? 10000;
    this.runtime = new StrategyRuntimeContext(initialBalance, {
      commission: options?.commission,
      fundingRateList: options?.fundingRateList,
      params: options?.params ?? strategy.params,
      rawConfig: options?.rawConfig,
      auxSeriesData: options?.auxSeriesData,
    });
    this.runtime.setStrategy(strategy);
    this.strategy = strategy;
  }

  feedBar(bar: Bar, maValues: MaValues): void {
    if (!this.initialized) {
      this.strategy.init?.(this.runtime);
      this.initialized = true;
    }
    this.runtime.processBar(bar, maValues);
    this.strategy.onBar(bar, maValues, this.runtime);
  }

  feedBars(barList: FeedBarInput[]): void {
    for (const item of barList) {
      this.feedBar(item.bar, item.maValues);
    }
  }

  end(): void {
    this.strategy.onEnd?.(this.runtime);
    this.runtime.forceCloseAll();
  }

  getRuntime(): StrategyRuntimeContext {
    return this.runtime;
  }

  getTradeList(): Trade[] {
    return this.runtime.getResult().tradeList;
  }

  getEquityList(): EquityPoint[] {
    return this.runtime.getResult().equityList;
  }

  getEventList(): BacktestEvent[] {
    return this.runtime.getResult().eventList;
  }

  getBalance(): number {
    return this.runtime.getBalance();
  }

  getOpenPositionList(): Position[] {
    return this.runtime.getPositionList();
  }

  getPendingOrderList(): PendingOrder[] {
    return this.runtime.getPendingOrderList();
  }
}
