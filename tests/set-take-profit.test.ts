import { describe, it, expect } from "vitest";
import { MockTradingEnv } from "../src/testing";
import { defineStrategy } from "../src";
import type { Bar, MaValues } from "../src";

const ZERO_MA: MaValues = { ma25: 0, ma50: 0, ma100: 0, ma200: 0 };

function makeBar(close: number, time: number, high?: number, low?: number): Bar {
  return {
    time,
    open: close,
    high: high ?? close + 1,
    low: low ?? close - 1,
    close,
    volume: 100,
  };
}

describe("setTakeProfit", () => {
  it("fills a long position at the exact take-profit price on the next touching bar", () => {
    const strategy = defineStrategy({
      name: "long-tp",
      version: "1.0",
      params: {},
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 95, 100);
        }
      },
      onOrderFill(order, env) {
        if (order.type === "limit") {
          env.setTakeProfit?.(order.positionId, 105);
        }
      },
    });

    const mock = new MockTradingEnv(strategy);
    mock.feedBar(makeBar(100, 1000), ZERO_MA);
    mock.feedBar(makeBar(96, 2000, 97, 94), ZERO_MA);
    mock.feedBar(makeBar(104, 3000, 106, 103), ZERO_MA);

    const trades = mock.getTradeList();

    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe("take_profit");
    expect(trades[0].entryPrice).toBe(95);
    expect(trades[0].exitPrice).toBe(105);
    expect(mock.getOpenPositionList()).toHaveLength(0);
  });

  it("fills a short position at the exact take-profit price on the next touching bar", () => {
    const strategy = defineStrategy({
      name: "short-tp",
      version: "1.0",
      params: {},
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("sell", 105, 100);
        }
      },
      onOrderFill(order, env) {
        if (order.type === "limit") {
          env.setTakeProfit?.(order.positionId, 95);
        }
      },
    });

    const mock = new MockTradingEnv(strategy);
    mock.feedBar(makeBar(100, 1000), ZERO_MA);
    mock.feedBar(makeBar(104, 2000, 106, 103), ZERO_MA);
    mock.feedBar(makeBar(96, 3000, 97, 94), ZERO_MA);

    const trades = mock.getTradeList();

    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe("take_profit");
    expect(trades[0].entryPrice).toBe(105);
    expect(trades[0].exitPrice).toBe(95);
    expect(mock.getOpenPositionList()).toHaveLength(0);
  });

  it("does not fill before the take-profit price is touched", () => {
    const strategy = defineStrategy({
      name: "long-tp-no-touch",
      version: "1.0",
      params: {},
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 95, 100);
        }
      },
      onOrderFill(order, env) {
        if (order.type === "limit") {
          env.setTakeProfit?.(order.positionId, 110);
        }
      },
    });

    const mock = new MockTradingEnv(strategy);
    mock.feedBar(makeBar(100, 1000), ZERO_MA);
    mock.feedBar(makeBar(96, 2000, 97, 94), ZERO_MA);
    mock.feedBar(makeBar(104, 3000, 106, 103), ZERO_MA);

    expect(mock.getTradeList()).toHaveLength(0);
    expect(mock.getOpenPositionList()).toHaveLength(1);
    expect(mock.getOpenPositionList()[0].takeProfit).toBe(110);
  });

  it("is a no-op for an unknown position id", () => {
    const strategy = defineStrategy({
      name: "unknown-id",
      version: "1.0",
      params: {},
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.openLong(100);
          env.setTakeProfit?.("pos_missing", 105);
        }
      },
    });

    const mock = new MockTradingEnv(strategy);
    mock.feedBar(makeBar(100, 1000), ZERO_MA);
    mock.feedBar(makeBar(104, 2000, 106, 103), ZERO_MA);

    expect(mock.getTradeList()).toHaveLength(0);
    expect(mock.getOpenPositionList()).toHaveLength(1);
    expect(mock.getOpenPositionList()[0].takeProfit).toBeUndefined();
  });
});
