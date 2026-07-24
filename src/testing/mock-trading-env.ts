import type {
  AuxSeriesData,
  Bar,
  BacktestContextOptions,
  BacktestEvent,
  EquityPoint,
  FundingRate,
  MaValues,
  OiProvider,
  ParamValue,
  PendingOrder,
  Position,
  Strategy,
  TimeframeData,
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
  timeframeDataList?: TimeframeData[];
  /** Live read-through OI source; when set, the runtime neither accumulates nor reads its own OI series. */
  oiProvider?: OiProvider;
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
      timeframeDataList: options?.timeframeDataList,
      oiProvider: options?.oiProvider,
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

  // Forwards an external user command (live/paper runners) to the strategy. The strategy is expected
  // to only mark snapshot-visible state and act on it in the next onBar, keeping replays
  // deterministic when the same commands are re-sent at the same bar boundaries.
  sendCommand(command: Record<string, unknown>): void {
    if (!this.strategy.onExternalCommand) return;

    if (!this.initialized) {
      this.strategy.init?.(this.runtime);
      this.initialized = true;
    }

    this.strategy.onExternalCommand(command, this.runtime);
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
