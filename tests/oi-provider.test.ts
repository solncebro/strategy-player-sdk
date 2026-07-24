import { describe, it, expect } from "vitest";
import { LiveStrategyRunner, PaperStrategyRunner } from "../src/live";
import type {
  CancelEntryOrderArgs,
  CancelProtectiveOrderArgs,
  ClosePositionMarketArgs,
  ClosePositionMarketResult,
  LiveExecutionPort,
  PlaceEntryOrderArgs,
  PlaceEntryOrderResult,
  ReplaceProtectiveOrderArgs,
  ReplaceProtectiveOrderResult,
} from "../src/live";
import { defineStrategy } from "../src";
import type { Bar, MaValues, OiOhlc } from "../src";

const ZERO_MA: MaValues = { ma25: 0, ma50: 0, ma100: 0, ma200: 0 };

class NoopExecutionPort implements LiveExecutionPort {
  async placeEntryOrder(_args: PlaceEntryOrderArgs): Promise<PlaceEntryOrderResult | null> {
    return { exchangeOrderId: "ex_1" };
  }

  async cancelEntryOrder(_args: CancelEntryOrderArgs): Promise<boolean> {
    return true;
  }

  async replaceStopLoss(_args: ReplaceProtectiveOrderArgs): Promise<ReplaceProtectiveOrderResult | null> {
    return { exchangeOrderIdList: ["exsl_1"], isComplete: true };
  }

  async cancelStopLoss(_args: CancelProtectiveOrderArgs): Promise<boolean> {
    return true;
  }

  async replaceTakeProfit(_args: ReplaceProtectiveOrderArgs): Promise<ReplaceProtectiveOrderResult | null> {
    return { exchangeOrderIdList: ["extp_1"], isComplete: true };
  }

  async cancelTakeProfit(_args: CancelProtectiveOrderArgs): Promise<boolean> {
    return true;
  }

  async closePositionMarket(_args: ClosePositionMarketArgs): Promise<ClosePositionMarketResult | null> {
    return { exitPrice: 100 };
  }
}

function makeBar(close: number, time: number): Bar {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 1 };
}

function makeOi(close: number, time: number): OiOhlc {
  return { time, open: close - 20, high: close + 1, low: close - 21, close };
}

function passiveStrategy() {
  return defineStrategy({ name: "oi-provider-probe", version: "1.0", params: {}, onBar() {} });
}

describe("oiProvider read-through", () => {
  it("LiveStrategyRunner resolves current and historical OI through the provider at call time", async () => {
    const oiByTime = new Map<number, OiOhlc>();
    const runner = new LiveStrategyRunner(passiveStrategy(), {
      port: new NoopExecutionPort(),
      oiProvider: (barTimeMs) => oiByTime.get(barTimeMs) ?? null,
    });

    await runner.feedClosedBar(makeBar(100, 1000));
    await runner.feedClosedBar(makeBar(98, 2000));
    await runner.feedClosedBar(makeBar(95, 3000));

    expect(runner.getOiOhlc()).toBeNull();
    expect(runner.getOiOhlcHistory(10)).toEqual([null, null]);

    oiByTime.set(1000, makeOi(500, 1000));
    oiByTime.set(2000, makeOi(520, 2000));
    oiByTime.set(3000, makeOi(560, 3000));

    expect(runner.getOiOhlc()?.close).toBe(560);
    expect(runner.getOiClose()).toBe(560);
    expect(runner.getOiOhlcHistory(10).map((bar) => bar?.close ?? null)).toEqual([500, 520]);
    expect(runner.getAuxHistory("oi", 10)).toEqual([500, 520]);
  });

  it("LiveStrategyRunner snapshot omits the OI series when a provider is set", async () => {
    const runner = new LiveStrategyRunner(passiveStrategy(), {
      port: new NoopExecutionPort(),
      oiProvider: () => null,
    });

    await runner.feedClosedBar(makeBar(100, 1000));
    const snapshot = runner.getSnapshot();

    expect(snapshot.oiHistory).toBeUndefined();
    expect(snapshot.currentOiBar).toBeUndefined();
    expect(snapshot.barHistory).toBeDefined();
  });

  it("LiveStrategyRunner without a provider keeps the frozen incremental series", async () => {
    const runner = new LiveStrategyRunner(passiveStrategy(), { port: new NoopExecutionPort() });

    await runner.feedClosedBar(makeBar(100, 1000), undefined, makeOi(500, 1000));
    await runner.feedClosedBar(makeBar(98, 2000));
    await runner.feedClosedBar(makeBar(95, 3000), undefined, makeOi(560, 3000));

    expect(runner.getOiOhlc()?.close).toBe(560);
    expect(runner.getOiOhlcHistory(10).map((bar) => bar?.close ?? null)).toEqual([500, null]);
  });

  it("PaperStrategyRunner resolves OI through the provider so late-arriving data heals blindness", () => {
    const oiByTime = new Map<number, OiOhlc>();
    const seenList: Array<{ currentClose: number | null; historyCloseList: Array<number | null> }> = [];
    const strategy = defineStrategy({
      name: "oi-provider-paper-probe",
      version: "1.0",
      params: {},
      onBar(_bar, _maValues, env) {
        seenList.push({
          currentClose: env.getOiOhlc?.()?.close ?? null,
          historyCloseList: (env.getOiOhlcHistory?.(10) ?? []).map((bar) => bar?.close ?? null),
        });
      },
    });
    const runner = new PaperStrategyRunner(strategy, { oiProvider: (barTimeMs) => oiByTime.get(barTimeMs) ?? null });

    runner.feedClosedBar(makeBar(100, 1000));
    oiByTime.set(1000, makeOi(500, 1000));
    oiByTime.set(2000, makeOi(520, 2000));
    runner.feedClosedBar(makeBar(98, 2000));

    expect(seenList[0]).toEqual({ currentClose: null, historyCloseList: [] });
    expect(seenList[1]).toEqual({ currentClose: 520, historyCloseList: [500] });
    expect(runner.getRuntime().getAuxHistory("oi", 10)).toEqual([500]);
    expect(runner.getRuntime().getOiClose()).toBe(520);
  });
});
