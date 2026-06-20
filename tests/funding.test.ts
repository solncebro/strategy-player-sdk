import { describe, it, expect } from "vitest";
import { StrategyRuntimeContext } from "../src/runtime";
import type { Bar } from "../src";

function makeBar(close: number, time: number): Bar {
  return { time, open: close, high: close + 10, low: close - 10, close, volume: 100 };
}

// behavior.md §6 — funding sign, the entryTime gate, and the applyFundingCost read-vs-charge split.
describe("StrategyRuntimeContext — funding model", () => {
  it("positive funding rate: a long PAYS (balance down, Trade.funding < 0)", () => {
    const ctx = new StrategyRuntimeContext(10000, {
      fundingRateList: [{ time: 2000, rate: 0.01 }],
    });

    ctx.processBar(makeBar(100, 1000));
    ctx.openLong(100); // entryTime = 1000
    ctx.processBar(makeBar(100, 2000)); // funding event at 2000: long pays 100 * 0.01 = 1
    ctx.closePosition();

    const trade = ctx.getResult().tradeList[0];

    expect(trade.funding).toBeCloseTo(-1, 9);
    expect(trade.netPnl).toBeCloseTo(-1, 9); // pnl 0, commission 0, funding -1
    expect(ctx.getBalance()).toBeCloseTo(9999, 9);
  });

  it("positive funding rate: a short RECEIVES (balance up, Trade.funding > 0)", () => {
    const ctx = new StrategyRuntimeContext(10000, {
      fundingRateList: [{ time: 2000, rate: 0.01 }],
    });

    ctx.processBar(makeBar(100, 1000));
    ctx.openShort(100); // entryTime = 1000
    ctx.processBar(makeBar(100, 2000)); // funding event at 2000: short receives 100 * 0.01 = 1
    ctx.closePosition();

    const trade = ctx.getResult().tradeList[0];

    expect(trade.funding).toBeCloseTo(1, 9);
    expect(ctx.getBalance()).toBeCloseTo(10001, 9);
  });

  it("a funding event earlier than a position's entryTime is NOT charged to it (entryTime gate)", () => {
    const ctx = new StrategyRuntimeContext(10000, {
      fundingRateList: [{ time: 1500, rate: 0.01 }],
    });

    ctx.processBar(makeBar(100, 1000));
    ctx.processBar(makeBar(100, 2000));
    ctx.openLong(100); // entryTime = 2000, AFTER the 1500 funding event
    ctx.processBar(makeBar(100, 3000)); // event at 1500 is consumed but gated out (1500 < 2000)
    ctx.closePosition();

    const trade = ctx.getResult().tradeList[0];

    expect(trade.funding).toBe(0);
    expect(ctx.getBalance()).toBe(10000);
  });

  it("applyFundingCost=false: rates stay readable but the cost is NOT charged to PnL", () => {
    const ctx = new StrategyRuntimeContext(10000, {
      fundingRateList: [
        { time: 1000, rate: 0.01 },
        { time: 2000, rate: 0.02 },
      ],
      applyFundingCost: false,
    });

    ctx.processBar(makeBar(100, 1000));
    ctx.openLong(100);

    // Readers work regardless of the cost flag (a funding strategy still needs its signal).
    expect(ctx.getCurrentFundingRate()).toBeCloseTo(0.01, 9);

    ctx.processBar(makeBar(100, 2000));

    expect(ctx.getCurrentFundingRate()).toBeCloseTo(0.02, 9);
    expect(ctx.getRecentFundingRates(2)).toEqual([0.01, 0.02]);

    ctx.closePosition();

    const trade = ctx.getResult().tradeList[0];

    expect(trade.funding).toBe(0); // cost suppressed
    expect(ctx.getBalance()).toBe(10000);
  });

  it("applyFundingCost defaults to true (cost charged when the option is omitted)", () => {
    const ctx = new StrategyRuntimeContext(10000, {
      fundingRateList: [{ time: 2000, rate: 0.01 }],
    });

    ctx.processBar(makeBar(100, 1000));
    ctx.openLong(100);
    ctx.processBar(makeBar(100, 2000));
    ctx.closePosition();

    expect(ctx.getResult().tradeList[0].funding).toBeCloseTo(-1, 9);
  });
});
