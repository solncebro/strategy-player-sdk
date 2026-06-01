import { describe, it, expect } from "vitest";
import { StrategyRuntimeContext } from "../src/runtime";
import type { AuxSeriesData, Bar } from "../src";

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

describe("StrategyRuntimeContext — runtime snapshot", () => {
  it("starts with initial balance and no position", () => {
    const ctx = new StrategyRuntimeContext(10000);

    expect(ctx.getBalance()).toBe(10000);
    expect(ctx.getPosition()).toBeNull();
  });

  it("opens and closes a long position", () => {
    const ctx = new StrategyRuntimeContext(10000);
    ctx.processBar(makeBar(100));

    ctx.openLong(100);
    expect(ctx.getPosition()?.side).toBe("long");
    expect(ctx.getPosition()?.entryPrice).toBe(100);

    ctx.processBar(makeBar(110));
    ctx.closeLong();

    expect(ctx.getPosition()).toBeNull();
    expect(ctx.getBalance()).toBe(10010);
  });

  it("opens and closes a short position", () => {
    const ctx = new StrategyRuntimeContext(10000);
    ctx.processBar(makeBar(100));

    ctx.openShort(100);
    ctx.processBar(makeBar(90));
    ctx.closeShort();

    expect(ctx.getBalance()).toBe(10010);
  });

  it("opens additional position alongside existing one with unique id", () => {
    const ctx = new StrategyRuntimeContext(10000);
    ctx.processBar(makeBar(100));
    ctx.openLong(100);
    ctx.openShort(100);

    const positionList = ctx.getPositionList();

    expect(positionList).toHaveLength(2);
    expect(positionList[0].side).toBe("long");
    expect(positionList[1].side).toBe("short");
    expect(positionList[0].id).not.toBe(positionList[1].id);
  });

  it("throws when closing wrong side", () => {
    const ctx = new StrategyRuntimeContext(10000);
    ctx.processBar(makeBar(100));
    ctx.openLong(100);

    expect(() => ctx.closeShort()).toThrow("no short position open");
  });

  it("triggers stop loss for long", () => {
    const ctx = new StrategyRuntimeContext(10000);
    ctx.processBar(makeBar(100));
    ctx.openLong(1, { stopLoss: 95 });

    ctx.processBar(makeBar(90, 2000000, 100, 94));

    expect(ctx.getPosition()).toBeNull();

    const result = ctx.getResult();

    expect(result.tradeList).toHaveLength(1);
    expect(result.tradeList[0].exitReason).toBe("stop_loss");
    expect(result.tradeList[0].exitPrice).toBe(95);
  });

  it("triggers take profit for long", () => {
    const ctx = new StrategyRuntimeContext(10000);
    ctx.processBar(makeBar(100));
    ctx.openLong(1, { takeProfit: 120 });

    ctx.processBar(makeBar(115, 2000000, 121, 110));

    expect(ctx.getPosition()).toBeNull();

    const result = ctx.getResult();

    expect(result.tradeList[0].exitReason).toBe("take_profit");
    expect(result.tradeList[0].exitPrice).toBe(120);
  });

  it("getHistory excludes current bar", () => {
    const ctx = new StrategyRuntimeContext(10000);
    ctx.processBar(makeBar(100, 1000000));
    ctx.processBar(makeBar(110, 2000000));
    ctx.processBar(makeBar(120, 3000000));

    const history = ctx.getHistory(10);

    expect(history).toHaveLength(2);
    expect(history[0].close).toBe(100);
    expect(history[1].close).toBe(110);
  });

  it("forceCloseAll closes open position", () => {
    const ctx = new StrategyRuntimeContext(10000);
    ctx.processBar(makeBar(100));
    ctx.openLong(100);
    ctx.processBar(makeBar(105));
    ctx.forceCloseAll();

    expect(ctx.getPosition()).toBeNull();

    const result = ctx.getResult();

    expect(result.tradeList[0].exitReason).toBe("end_of_data");
  });

  it("tracks equity after each bar", () => {
    const ctx = new StrategyRuntimeContext(10000);
    ctx.processBar(makeBar(100));
    ctx.processBar(makeBar(110));
    ctx.processBar(makeBar(105));

    const result = ctx.getResult();

    expect(result.equityList).toHaveLength(3);
  });

  describe("aux series accessors", () => {
    function makeAuxSeriesData(): AuxSeriesData {
      return {
        oiByTime: new Map([
          [1000, 50_000],
          [2000, 51_000],
          [3000, 49_500],
        ]),
        liqLongByTime: new Map([
          [1000, 100_000],
          [2000, 200_000],
        ]),
        liqShortByTime: new Map([
          [1000, 50_000],
          [3000, 75_000],
        ]),
        lsrByTime: new Map([
          [2000, 1.25],
        ]),
      };
    }

    it("returns null for aux methods when no auxSeriesData provided", () => {
      const ctx = new StrategyRuntimeContext(10000);
      ctx.processBar(makeBar(100, 1000));

      expect(ctx.getOiClose()).toBeNull();
      expect(ctx.getLiqLongUsd()).toBeNull();
      expect(ctx.getLiqShortUsd()).toBeNull();
      expect(ctx.getLongShortRatio()).toBeNull();
      expect(ctx.getAuxHistory("oi", 5)).toEqual([]);
    });

    it("returns aux value at current bar timestamp", () => {
      const ctx = new StrategyRuntimeContext(10000, { auxSeriesData: makeAuxSeriesData() });
      ctx.processBar(makeBar(100, 1000));

      expect(ctx.getOiClose()).toBe(50_000);
      expect(ctx.getLiqLongUsd()).toBe(100_000);
      expect(ctx.getLiqShortUsd()).toBe(50_000);
      expect(ctx.getLongShortRatio()).toBeNull();
    });

    it("returns null when source has no entry for current bar timestamp", () => {
      const ctx = new StrategyRuntimeContext(10000, { auxSeriesData: makeAuxSeriesData() });
      ctx.processBar(makeBar(100, 5000));

      expect(ctx.getOiClose()).toBeNull();
      expect(ctx.getLongShortRatio()).toBeNull();
    });

    it("getAuxHistory excludes current bar (no look-ahead) and preserves nulls", () => {
      const ctx = new StrategyRuntimeContext(10000, { auxSeriesData: makeAuxSeriesData() });
      ctx.processBar(makeBar(100, 1000));
      ctx.processBar(makeBar(110, 2000));
      ctx.processBar(makeBar(105, 3000));

      const oiHistory = ctx.getAuxHistory("oi", 10);
      const liqShortHistory = ctx.getAuxHistory("liqShort", 10);
      const lsrHistory = ctx.getAuxHistory("lsr", 10);

      expect(oiHistory).toEqual([50_000, 51_000]);
      expect(liqShortHistory).toEqual([50_000, null]);
      expect(lsrHistory).toEqual([null, 1.25]);

      expect(ctx.getOiClose()).toBe(49_500);
    });

    it("getAuxHistory caps at requested count", () => {
      const ctx = new StrategyRuntimeContext(10000, { auxSeriesData: makeAuxSeriesData() });
      ctx.processBar(makeBar(100, 1000));
      ctx.processBar(makeBar(110, 2000));
      ctx.processBar(makeBar(105, 3000));

      const oiOne = ctx.getAuxHistory("oi", 1);

      expect(oiOne).toEqual([51_000]);
    });
  });
});
