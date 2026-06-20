import type { BacktestEvent, Bar, MaValues, OiOhlc } from "../types";
import { MockTradingEnv } from "../testing/mock-trading-env";

const ZERO_MA: MaValues = { ma25: 0, ma50: 0, ma100: 0, ma200: 0 };

/**
 * Real-time paper engine: the exact backtest runtime fed with live closed bars. Fills, stop-losses,
 * take-profits, commissions and equity all follow the backtest semantics, so a strategy paper-trades
 * with literally the same engine the player backtests with. Adds incremental event draining so the
 * host can forward freshly emitted events (notifications, journaling) after each bar.
 */
export class PaperStrategyRunner extends MockTradingEnv {
  private drainedEventCount = 0;

  feedClosedBar(bar: Bar, maValues?: MaValues, oiBar?: OiOhlc): void {
    if (oiBar) this.getRuntime().setOiOhlc(bar.time, oiBar);
    this.feedBar(bar, maValues ?? ZERO_MA);
  }

  /**
   * Replay a historical closed bar to build price/open-interest history WITHOUT
   * running the strategy — no trades, no events. Used for paper warmup so the bot
   * starts flat and only acts on candles that close after it goes live.
   */
  catchUpBar(bar: Bar, maValues?: MaValues, oiBar?: OiOhlc): void {
    if (oiBar) this.getRuntime().setOiOhlc(bar.time, oiBar);
    this.getRuntime().processBar(bar, maValues ?? ZERO_MA);
  }

  drainNewEventList(): BacktestEvent[] {
    const eventList = this.getEventList();
    const newEventList = eventList.slice(this.drainedEventCount);

    this.drainedEventCount = eventList.length;

    return newEventList;
  }
}
