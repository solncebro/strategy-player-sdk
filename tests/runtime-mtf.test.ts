import { describe, it, expect } from "vitest";
import { StrategyRuntimeContext, barDurationMs } from "../src/runtime";
import type { AuxSeriesData, Bar, TimeframeData } from "../src";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function makeBar(time: number, close: number, high?: number, low?: number): Bar {
  return {
    time,
    open: close,
    high: high ?? close + 10,
    low: low ?? close - 10,
    close,
    volume: 100,
  };
}

function makeDailyBars(count: number, startCloseValue: number): Bar[] {
  const barList: Bar[] = [];

  for (let i = 0; i < count; i++) {
    barList.push(makeBar(i * DAY_MS, startCloseValue + i));
  }

  return barList;
}

describe("barDurationMs", () => {
  it("returns correct ms for each supported resolution", () => {
    expect(barDurationMs("1")).toBe(60_000);
    expect(barDurationMs("15")).toBe(900_000);
    expect(barDurationMs("30")).toBe(1_800_000);
    expect(barDurationMs("60")).toBe(3_600_000);
    expect(barDurationMs("240")).toBe(14_400_000);
    expect(barDurationMs("1D")).toBe(86_400_000);
  });

  it("throws for unsupported resolution", () => {
    expect(() => barDurationMs("5")).toThrow("Unsupported resolution");
  });
});

describe("StrategyRuntimeContext — MTF lookups", () => {
  it("throws when reading from an undeclared timeframe", () => {
    const ctx = new StrategyRuntimeContext(10000);
    ctx.processBar(makeBar(0, 100));

    expect(() => ctx.getHistory(5, "1D")).toThrow(/not loaded.*requiredTimeframes/);
    expect(() => ctx.getOiClose("1D")).toThrow(/not loaded/);
  });

  it("respects look-ahead invariant on secondary TF", () => {
    const dailyBarList = makeDailyBars(5, 100);
    const timeframeDataList: TimeframeData[] = [
      { resolution: "1D", barList: dailyBarList },
    ];

    const ctx = new StrategyRuntimeContext(10000, { timeframeDataList });

    // tick 1: main bar at t=0 (start of day 0) — no daily bar closed yet
    ctx.processBar(makeBar(0, 50));
    expect(ctx.getHistory(10, "1D")).toEqual([]);

    // tick 2: main bar at t=HOUR_MS — still no daily bar closed
    ctx.processBar(makeBar(HOUR_MS, 51));
    expect(ctx.getHistory(10, "1D")).toEqual([]);

    // tick 3: main bar at t=DAY_MS (start of day 1) — daily bar #0 (t=0..DAY_MS) closed
    ctx.processBar(makeBar(DAY_MS, 52));
    const afterDay1 = ctx.getHistory(10, "1D");
    expect(afterDay1).toHaveLength(1);
    expect(afterDay1[0].time).toBe(0);
    expect(afterDay1[0].close).toBe(100);

    // tick 4: main bar at t=2*DAY_MS — daily bars #0 and #1 closed
    ctx.processBar(makeBar(2 * DAY_MS, 53));
    const afterDay2 = ctx.getHistory(10, "1D");
    expect(afterDay2).toHaveLength(2);
    expect(afterDay2.map((b) => b.close)).toEqual([100, 101]);

    // tick at t=DAY_MS - 1 (last ms before day 0 closes) — should NOT see day 0
    // (we already passed t=DAY_MS in tick 3, so this would be out-of-order; skip)
  });

  it("getHistory with resolution returns last N closed bars including the most recent", () => {
    const dailyBarList = makeDailyBars(10, 100); // closes 100..109
    const ctx = new StrategyRuntimeContext(10000, {
      timeframeDataList: [{ resolution: "1D", barList: dailyBarList }],
    });

    // advance to t=5*DAY_MS → daily bars #0..#4 (closes 100..104) should be visible
    for (let i = 0; i <= 5; i++) {
      ctx.processBar(makeBar(i * DAY_MS, 50 + i));
    }

    const last3 = ctx.getHistory(3, "1D");
    expect(last3).toHaveLength(3);
    expect(last3.map((b) => b.close)).toEqual([102, 103, 104]);
  });

  it("getOiClose with resolution returns aux for the most recent closed secondary bar", () => {
    const dailyBarList = makeDailyBars(5, 100);
    const dailyAux: AuxSeriesData = {
      oiByTime: new Map([
        [0, 10_000],
        [DAY_MS, 11_000],
        [2 * DAY_MS, 12_000],
      ]),
      liqLongByTime: new Map(),
      liqShortByTime: new Map(),
      lsrByTime: new Map(),
    };

    const ctx = new StrategyRuntimeContext(10000, {
      timeframeDataList: [{ resolution: "1D", barList: dailyBarList, auxSeriesData: dailyAux }],
    });

    ctx.processBar(makeBar(0, 50));
    expect(ctx.getOiClose("1D")).toBeNull(); // no daily bar closed yet

    ctx.processBar(makeBar(DAY_MS, 51)); // daily #0 closed
    expect(ctx.getOiClose("1D")).toBe(10_000);

    ctx.processBar(makeBar(2 * DAY_MS, 52)); // daily #1 closed
    expect(ctx.getOiClose("1D")).toBe(11_000);

    ctx.processBar(makeBar(3 * DAY_MS, 53)); // daily #2 closed
    expect(ctx.getOiClose("1D")).toBe(12_000);
  });

  it("getAuxHistory with resolution returns closed-bar history with nulls preserved", () => {
    const dailyBarList = makeDailyBars(4, 100);
    const dailyAux: AuxSeriesData = {
      oiByTime: new Map([
        [0, 10_000],
        [2 * DAY_MS, 12_000], // gap at DAY_MS
      ]),
      liqLongByTime: new Map(),
      liqShortByTime: new Map(),
      lsrByTime: new Map(),
    };

    const ctx = new StrategyRuntimeContext(10000, {
      timeframeDataList: [{ resolution: "1D", barList: dailyBarList, auxSeriesData: dailyAux }],
    });

    for (let i = 0; i <= 3; i++) {
      ctx.processBar(makeBar(i * DAY_MS, 50 + i));
    }

    expect(ctx.getAuxHistory("oi", 10, "1D")).toEqual([10_000, null, 12_000]);
  });

  it("getMaValues computes SMA from closed bars on secondary TF, zero before warm-up", () => {
    // 30 daily bars all closing at 100 → SMA25 = 100 after 25 closed bars, 0 before
    const dailyBarList = makeDailyBars(30, 0).map((b) => ({ ...b, close: 100 }));

    const ctx = new StrategyRuntimeContext(10000, {
      timeframeDataList: [{ resolution: "1D", barList: dailyBarList }],
    });

    // tick at t=0 — 0 daily bars closed
    ctx.processBar(makeBar(0, 50));
    expect(ctx.getMaValues("1D")).toEqual({
      ma25: 0,
      ma50: 0,
      ma100: 0,
      ma200: 0,
      ma99: null,
      ma1000: null,
    });

    // advance 24 days → 24 daily bars closed → SMA25 still 0 (need 25)
    for (let i = 1; i <= 24; i++) ctx.processBar(makeBar(i * DAY_MS, 50));
    expect(ctx.getMaValues("1D").ma25).toBe(0);

    // advance 1 more day → 25 daily bars closed → SMA25 = 100
    ctx.processBar(makeBar(25 * DAY_MS, 50));
    const ma = ctx.getMaValues("1D");
    expect(ma.ma25).toBe(100);
    expect(ma.ma50).toBe(0); // need 50, only have 25 closed
    expect(ma.ma100).toBe(0);
    expect(ma.ma200).toBe(0);
  });

  it("getMaValues caches per (resolution, currentIndex)", () => {
    const dailyBarList = makeDailyBars(30, 0).map((b) => ({ ...b, close: 100 }));
    const ctx = new StrategyRuntimeContext(10000, {
      timeframeDataList: [{ resolution: "1D", barList: dailyBarList }],
    });

    for (let i = 0; i <= 25; i++) ctx.processBar(makeBar(i * DAY_MS, 50));

    const first = ctx.getMaValues("1D");
    const second = ctx.getMaValues("1D");
    expect(second).toBe(first); // same object reference → cached
  });

  it("does not affect main-TF semantics when secondary TF declared", () => {
    // main-TF getHistory should still exclude current bar
    const dailyBarList = makeDailyBars(2, 100);
    const ctx = new StrategyRuntimeContext(10000, {
      timeframeDataList: [{ resolution: "1D", barList: dailyBarList }],
    });

    ctx.processBar(makeBar(0, 50));
    ctx.processBar(makeBar(HOUR_MS, 51));
    ctx.processBar(makeBar(2 * HOUR_MS, 52));

    const mainHist = ctx.getHistory(10);
    expect(mainHist).toHaveLength(2);
    expect(mainHist.map((b) => b.close)).toEqual([50, 51]);
  });

  it("works with multiple secondary timeframes simultaneously", () => {
    const dailyBarList = makeDailyBars(3, 100);
    const fourHourBarList: Bar[] = [0, 1, 2, 3, 4, 5].map((i) =>
      makeBar(i * 4 * HOUR_MS, 200 + i),
    );

    const ctx = new StrategyRuntimeContext(10000, {
      timeframeDataList: [
        { resolution: "1D", barList: dailyBarList },
        { resolution: "240", barList: fourHourBarList },
      ],
    });

    // tick at t=8h: 4h bars #0 (t=0..4h) and #1 (t=4h..8h) closed; no daily closed
    ctx.processBar(makeBar(8 * HOUR_MS, 50));
    expect(ctx.getHistory(10, "240").map((b) => b.close)).toEqual([200, 201]);
    expect(ctx.getHistory(10, "1D")).toEqual([]);

    // tick at t=DAY_MS: daily #0 closed; 4h bars #0..#5 closed
    ctx.processBar(makeBar(DAY_MS, 51));
    expect(ctx.getHistory(10, "1D").map((b) => b.close)).toEqual([100]);
    expect(ctx.getHistory(10, "240").map((b) => b.close)).toEqual([200, 201, 202, 203, 204, 205]);
  });

  it("handles unsorted input bars by sorting in store", () => {
    const dailyBarList: Bar[] = [
      makeBar(2 * DAY_MS, 102),
      makeBar(0, 100),
      makeBar(DAY_MS, 101),
    ];

    const ctx = new StrategyRuntimeContext(10000, {
      timeframeDataList: [{ resolution: "1D", barList: dailyBarList }],
    });

    ctx.processBar(makeBar(3 * DAY_MS, 50));
    expect(ctx.getHistory(10, "1D").map((b) => b.close)).toEqual([100, 101, 102]);
  });
});
