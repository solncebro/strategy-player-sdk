import { describe, it, expect } from "vitest";
import { MockTradingEnv } from "../src/testing";
import { defineStrategy } from "../src";
import type { Bar, MaValues } from "../src";

const ZERO_MA: MaValues = { ma25: 0, ma50: 0, ma100: 0, ma200: 0 };

function makeBar(close: number, time = 1000000, high?: number, low?: number): Bar {
  return {
    time,
    open: close,
    high: high ?? close + 10,
    low: low ?? close - 10,
    close,
    volume: 100,
  };
}

describe("MockTradingEnv", () => {
  it("calls init exactly once before first onBar", () => {
    const calls: string[] = [];

    const strategy = defineStrategy({
      name: "trace",
      version: "1.0",
      params: {},
      init() {
        calls.push("init");
      },
      onBar() {
        calls.push("onBar");
      },
    });

    const mock = new MockTradingEnv(strategy);
    mock.feedBar(makeBar(100), ZERO_MA);
    mock.feedBar(makeBar(101), ZERO_MA);

    expect(calls).toEqual(["init", "onBar", "onBar"]);
  });

  it("delegates trade lifecycle to StrategyRuntimeContext", () => {
    const strategy = defineStrategy({
      name: "long-and-close",
      version: "1.0",
      params: {},
      onBar(bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.openLong(100);
        } else if (env.getBarIndex() === 1 && env.getPosition()?.side === "long") {
          env.closeLong();
        }
      },
    });

    const mock = new MockTradingEnv(strategy);
    mock.feedBar(makeBar(100), ZERO_MA);
    mock.feedBar(makeBar(110, 2000000), ZERO_MA);

    const tradeList = mock.getTradeList();
    expect(tradeList).toHaveLength(1);
    expect(tradeList[0].entryPrice).toBe(100);
    expect(tradeList[0].exitPrice).toBe(110);
    expect(tradeList[0].pnl).toBe(10);
    expect(mock.getBalance()).toBe(10010);
  });

  it("captures emitted events", () => {
    const strategy = defineStrategy({
      name: "emitter",
      version: "1.0",
      params: {},
      onBar(_bar, _ma, env) {
        env.emitEvent("tick", { idx: env.getBarIndex() });
      },
    });

    const mock = new MockTradingEnv(strategy);
    mock.feedBars([
      { bar: makeBar(100, 1000), maValues: ZERO_MA },
      { bar: makeBar(101, 2000), maValues: ZERO_MA },
    ]);

    const events = mock.getEventList();
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("tick");
    expect(events[0].data).toEqual({ idx: 0 });
    expect(events[1].time).toBe(2000);
  });

  it("end() calls onEnd and forces position closure", () => {
    const calls: string[] = [];

    const strategy = defineStrategy({
      name: "force-close",
      version: "1.0",
      params: {},
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) env.openLong(100);
      },
      onEnd() {
        calls.push("onEnd");
      },
    });

    const mock = new MockTradingEnv(strategy);
    mock.feedBar(makeBar(100), ZERO_MA);
    mock.feedBar(makeBar(105, 2000000), ZERO_MA);
    mock.end();

    expect(calls).toEqual(["onEnd"]);
    expect(mock.getOpenPositionList()).toHaveLength(0);

    const tradeList = mock.getTradeList();
    expect(tradeList).toHaveLength(1);
    expect(tradeList[0].exitReason).toBe("end_of_data");
  });
});
