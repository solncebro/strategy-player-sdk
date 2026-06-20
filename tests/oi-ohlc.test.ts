import { describe, it, expect } from "vitest";
import { PaperStrategyRunner } from "../src/live";
import { StrategyRuntimeContext } from "../src/runtime/strategy-runtime-context";
import { defineStrategy } from "../src";
import type { AuxSeriesData, Bar, MaValues, OiOhlc } from "../src";

const ZERO_MA: MaValues = { ma25: 0, ma50: 0, ma100: 0, ma200: 0 };

function makeBar(close: number, time: number): Bar {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 1 };
}

function makeOi(close: number, time: number, open: number): OiOhlc {
  return { time, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close };
}

function emptyAux(): AuxSeriesData {
  return {
    oiByTime: new Map(),
    liqLongByTime: new Map(),
    liqShortByTime: new Map(),
    lsrByTime: new Map(),
  };
}

describe("open-interest OHLC contract", () => {
  it("PaperStrategyRunner serves OHLC open interest fed incrementally per bar", () => {
    const seen: Array<{ curClose: number | null; curBody: number | null; histLen: number; lastHistClose: number | null }> = [];

    const strategy = defineStrategy({
      name: "oi-reader",
      version: "1.0",
      params: {},
      onBar(_bar, _ma, env) {
        const cur = env.getOiOhlc?.() ?? null;
        const hist = env.getOiOhlcHistory?.(10) ?? [];
        seen.push({
          curClose: cur?.close ?? null,
          curBody: cur ? cur.close - cur.open : null,
          histLen: hist.length,
          lastHistClose: hist.length ? (hist[hist.length - 1]?.close ?? null) : null,
        });
      },
    });

    const runner = new PaperStrategyRunner(strategy);
    runner.feedClosedBar(makeBar(100, 1000), ZERO_MA, makeOi(500, 1000, 480));
    runner.feedClosedBar(makeBar(98, 2000), ZERO_MA, makeOi(520, 2000, 500));
    runner.feedClosedBar(makeBar(95, 3000), ZERO_MA, makeOi(560, 3000, 520));

    expect(seen[0]).toEqual({ curClose: 500, curBody: 20, histLen: 0, lastHistClose: null });
    expect(seen[1]).toEqual({ curClose: 520, curBody: 20, histLen: 1, lastHistClose: 500 });
    expect(seen[2]).toEqual({ curClose: 560, curBody: 40, histLen: 2, lastHistClose: 520 });
  });

  it("StrategyRuntimeContext serves OHLC open interest from a preloaded map (backtest path)", () => {
    const oiOhlcByTime = new Map<number, OiOhlc>([
      [1000, makeOi(500, 1000, 480)],
      [2000, makeOi(520, 2000, 500)],
    ]);

    const ctx = new StrategyRuntimeContext(10000, {
      auxSeriesData: { ...emptyAux(), oiOhlcByTime },
    });

    ctx.processBar(makeBar(100, 1000), ZERO_MA);
    expect(ctx.getOiOhlc()?.close).toBe(500);
    expect(ctx.getOiOhlcHistory(10)).toHaveLength(0);

    ctx.processBar(makeBar(98, 2000), ZERO_MA);
    expect(ctx.getOiOhlc()?.close).toBe(520);

    const hist = ctx.getOiOhlcHistory(10);
    expect(hist).toHaveLength(1);
    expect(hist[0]?.close).toBe(500);
  });

  it("does not mutate the shared empty aux series across runtime instances", () => {
    const ctxA = new StrategyRuntimeContext(10000);
    ctxA.setOiOhlc(1000, makeOi(500, 1000, 480));
    ctxA.processBar(makeBar(100, 1000), ZERO_MA);
    expect(ctxA.getOiOhlc()?.close).toBe(500);

    const ctxB = new StrategyRuntimeContext(10000);
    ctxB.processBar(makeBar(100, 1000), ZERO_MA);
    expect(ctxB.getOiOhlc()).toBeNull();
  });
});
