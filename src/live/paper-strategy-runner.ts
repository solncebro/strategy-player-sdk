import type { BacktestEvent, Bar, MaValues, OiOhlc, Strategy } from "../types";
import { MockTradingEnv } from "../testing/mock-trading-env";
import type { MockTradingEnvOptions } from "../testing/mock-trading-env";

const ZERO_MA: MaValues = { ma25: 0, ma50: 0, ma100: 0, ma200: 0 };
/** Label for the single timeframe a live/paper feed carries (the player passes a real "30"/"240"/…). */
const LIVE_RESOLUTION = "live";

/**
 * Real-time paper engine: the exact backtest runtime fed with live closed bars. Fills, stop-losses,
 * take-profits, commissions and equity all follow the backtest semantics, so a strategy paper-trades
 * with literally the same engine the player backtests with. Adds incremental event draining so the
 * host can forward freshly emitted events (notifications, journaling) after each bar.
 */
export class PaperStrategyRunner extends MockTradingEnv {
  private drainedEventCount = 0;
  /** The runtime's own 24h-volume series, filled bar by bar (the player loads it upfront instead). */
  private readonly volume24hByTime = new Map<number, number>();
  private isVolumeSeriesRegistered = false;
  private readonly resolution: string;

  constructor(strategy: Strategy, options?: MockTradingEnvOptions) {
    super(strategy, options);
    // A live feed always carries exactly one timeframe, and it IS the runtime's main resolution — the
    // label the host supplies, or a placeholder when it does not name one (a no-argument getVolume24h()
    // resolves through the main resolution, so it can never be left unset).
    this.resolution = options?.resolution ?? LIVE_RESOLUTION;
    this.getRuntime().setMainResolution(this.resolution);
  }

  feedClosedBar(bar: Bar, maValues?: MaValues, oiBar?: OiOhlc, volume24hUsd?: number): void {
    if (oiBar) this.getRuntime().setOiOhlc(bar.time, oiBar);
    this.rememberVolume24h(bar.time, volume24hUsd);
    this.feedBar(bar, maValues ?? ZERO_MA);
  }

  /**
   * Replay a historical closed bar to build price/open-interest history WITHOUT
   * running the strategy — no trades, no events. Used for paper warmup so the bot
   * starts flat and only acts on candles that close after it goes live.
   */
  catchUpBar(bar: Bar, maValues?: MaValues, oiBar?: OiOhlc, volume24hUsd?: number): void {
    if (oiBar) this.getRuntime().setOiOhlc(bar.time, oiBar);
    this.rememberVolume24h(bar.time, volume24hUsd);
    this.getRuntime().processBar(bar, maValues ?? ZERO_MA);
  }

  /**
   * Feeds the turnover into the runtime's EXISTING volume series (the one the backtest player fills
   * from the database) instead of adding a second store: live bars arrive one at a time, so the map is
   * registered once and then grown in place — the runtime holds it by reference.
   */
  private rememberVolume24h(time: number, volume24hUsd?: number): void {
    if (volume24hUsd === undefined) return;

    this.volume24hByTime.set(time, volume24hUsd);

    if (this.isVolumeSeriesRegistered) return;

    // Registered under the host's own resolution label (options.resolution, already applied as the main
    // resolution) so BOTH call styles work exactly as in the player: getVolume24h() and getVolume24h("30").
    this.getRuntime().setVolume24hForResolution(this.resolution, this.volume24hByTime);
    this.isVolumeSeriesRegistered = true;
  }

  drainNewEventList(): BacktestEvent[] {
    const eventList = this.getEventList();
    const newEventList = eventList.slice(this.drainedEventCount);

    this.drainedEventCount = eventList.length;

    return newEventList;
  }
}
