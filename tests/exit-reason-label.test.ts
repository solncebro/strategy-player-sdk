import { describe, it, expect } from "vitest";
import { MockTradingEnv } from "../src/testing";
import { defineStrategy } from "../src";
import type { Bar, MaValues } from "../src";

const ZERO_MA: MaValues = { ma25: 0, ma50: 0, ma100: 0, ma200: 0 };

interface MakeBarArgs {
  close: number;
  time: number;
  high?: number;
  low?: number;
}

function makeBar(args: MakeBarArgs): Bar {
  return {
    time: args.time,
    open: args.close,
    high: args.high ?? args.close + 1,
    low: args.low ?? args.close - 1,
    close: args.close,
    volume: 100,
  };
}

interface ShortStrategyArgs {
  takeReason?: string;
  stopReason?: string;
  take: number;
  stop: number;
}

// A short limit at 105 that arms a labeled take/stop on fill. The `reason` args are
// the machine codes the player later maps to a human label ("Take Profit (MA200)", ...).
function shortStrategy(opts: ShortStrategyArgs) {
  return defineStrategy({
    name: "labeled-exit",
    version: "1.0",
    params: {},
    onBar(_bar, _ma, env) {
      if (env.getBarIndex() === 0) env.placeLimitOrder("sell", 105, 100);
    },
    onOrderFill(order, env) {
      if (order.type !== "limit") return;
      env.setTakeProfit?.(order.positionId, opts.take, opts.takeReason);
      env.setStopLoss(order.positionId, opts.stop, opts.stopReason);
    },
  });
}

describe("exit-reason labels", () => {
  it("records the take-profit reason code as Trade.exitReason", () => {
    // Fill the sell limit at 105 (bar high 106), then dip to touch the take at 95.
    const mock = new MockTradingEnv(shortStrategy({ take: 95, stop: 200, takeReason: "take_profit_ma200" }));
    mock.feedBar(makeBar({ close: 100, time: 1000 }), ZERO_MA);
    mock.feedBar(makeBar({ close: 104, time: 2000, high: 106, low: 103 }), ZERO_MA);
    mock.feedBar(makeBar({ close: 96, time: 3000, high: 97, low: 94 }), ZERO_MA);

    const trades = mock.getTradeList();

    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe("take_profit_ma200");
    expect(trades[0].exitPrice).toBe(95);
  });

  it("records the stop-loss reason code (with embedded number) as Trade.exitReason", () => {
    // Fill at 105, then spike to 120 which sweeps the stop at 115.
    const mock = new MockTradingEnv(shortStrategy({ take: 1, stop: 115, stopReason: "stop_loss_emergency|15" }));
    mock.feedBar(makeBar({ close: 100, time: 1000 }), ZERO_MA);
    mock.feedBar(makeBar({ close: 104, time: 2000, high: 106, low: 103 }), ZERO_MA);
    mock.feedBar(makeBar({ close: 110, time: 3000, high: 120, low: 108 }), ZERO_MA);

    const trades = mock.getTradeList();

    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe("stop_loss_emergency|15");
    expect(trades[0].exitPrice).toBe(115);
  });

  it("falls back to take_profit / stop_loss when no reason is given (backward compat)", () => {
    const takeMock = new MockTradingEnv(shortStrategy({ take: 95, stop: 200 }));
    takeMock.feedBar(makeBar({ close: 100, time: 1000 }), ZERO_MA);
    takeMock.feedBar(makeBar({ close: 104, time: 2000, high: 106, low: 103 }), ZERO_MA);
    takeMock.feedBar(makeBar({ close: 96, time: 3000, high: 97, low: 94 }), ZERO_MA);
    expect(takeMock.getTradeList()[0].exitReason).toBe("take_profit");

    const stopMock = new MockTradingEnv(shortStrategy({ take: 1, stop: 115 }));
    stopMock.feedBar(makeBar({ close: 100, time: 1000 }), ZERO_MA);
    stopMock.feedBar(makeBar({ close: 104, time: 2000, high: 106, low: 103 }), ZERO_MA);
    stopMock.feedBar(makeBar({ close: 110, time: 3000, high: 120, low: 108 }), ZERO_MA);
    expect(stopMock.getTradeList()[0].exitReason).toBe("stop_loss");
  });

  it("passes a strategy-authored market-exit reason (with embedded number) straight through", () => {
    const strategy = defineStrategy({
      name: "market-exit-reason",
      version: "1.0",
      params: {},
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) env.openShort(100);
        if (env.getBarIndex() === 1) env.closeAllPositions("close_stop|8");
      },
    });

    const mock = new MockTradingEnv(strategy);
    mock.feedBar(makeBar({ close: 100, time: 1000 }), ZERO_MA);
    mock.feedBar(makeBar({ close: 100, time: 2000 }), ZERO_MA);

    const trades = mock.getTradeList();

    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe("close_stop|8");
  });
});
