import { describe, it, expect } from "vitest";
import { StrategyRuntimeContext } from "../src/runtime";
import type { Bar, FilledOrder, Strategy, TradingEnv } from "../src";

interface BarArgs {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function bar(args: BarArgs): Bar {
  return { time: args.time, open: args.open, high: args.high, low: args.low, close: args.close, volume: 100 };
}

// A minimal strategy that arms a protective stop the instant a limit entry fills
// (short: +15% above the fill, long: −15% below), mirroring oi-divergence-short.
function stopOnFillStrategy(): Strategy {
  return {
    name: "stop-on-fill",
    version: "1.0",
    onBar() {},
    onOrderFill(order: FilledOrder, env: TradingEnv) {
      if (order.type !== "limit" || !order.positionId) return;
      const stop = order.side === "sell" ? order.price * 1.15 : order.price * 0.85;
      env.setStopLoss(order.positionId, stop);
    },
  };
}

describe("entry-bar stop-loss", () => {
  it("SHORT: fires on the entry candle when the candle high blows past the stop", () => {
    const ctx = new StrategyRuntimeContext(10000);
    ctx.setStrategy(stopOnFillStrategy());

    ctx.processBar(bar({ time: 1000, open: 100, high: 100, low: 100, close: 100 }));
    ctx.placeLimitOrder("sell", 100, 1000); // short limit at 100 → stop will be 115

    // Pump candle: fills the limit at 100, then high 200 sweeps past the 115 stop.
    ctx.processBar(bar({ time: 2000, open: 100, high: 200, low: 90, close: 200 }));

    const { tradeList } = ctx.getResult();

    expect(ctx.getPositionList()).toHaveLength(0);
    expect(tradeList).toHaveLength(1);
    expect(tradeList[0].side).toBe("short");
    expect(tradeList[0].entryPrice).toBe(100);
    expect(tradeList[0].exitPrice).toBeCloseTo(115, 5); // closed AT the stop, not at bar close 200
    expect(tradeList[0].exitReason).toBe("stop_loss");
    expect(tradeList[0].entryTime).toBe(2000);
    expect(tradeList[0].exitTime).toBe(2000); // same candle
    // Loss capped at −15% of size (minus commissions), not −100%.
    expect(tradeList[0].pnl).toBeCloseTo(-150, 5);
  });

  it("LONG entered at the candle low: stop below is NOT breached on the entry candle", () => {
    const ctx = new StrategyRuntimeContext(10000);
    ctx.setStrategy(stopOnFillStrategy());

    ctx.processBar(bar({ time: 1000, open: 110, high: 110, low: 110, close: 110 }));
    ctx.placeLimitOrder("buy", 100, 1000); // long limit at 100 → stop will be 85

    // Candle dips to exactly 100 (fills the buy at the low) then rallies; low == entry,
    // so the 85 stop below can never have been touched after entry.
    ctx.processBar(bar({ time: 2000, open: 105, high: 112, low: 100, close: 108 }));

    const positionList = ctx.getPositionList();

    expect(positionList).toHaveLength(1);
    expect(positionList[0].side).toBe("long");
    expect(positionList[0].entryPrice).toBe(100);
    expect(ctx.getResult().tradeList).toHaveLength(0); // still open, no stop fired
  });

  it("MARKET entry (opens at bar close in onBar): no stop check on the entry candle", () => {
    const ctx = new StrategyRuntimeContext(10000);

    // Entry bar's high (200) already exceeds the stop (115), but a market entry opens at
    // this bar's CLOSE (after processBar), so that excursion is BEFORE entry and must not
    // stop it out. First stop check is the next bar.
    ctx.processBar(bar({ time: 1000, open: 100, high: 200, low: 90, close: 100 }));
    ctx.openShort(1000, { stopLoss: 115 }); // market short at close 100, stop 115

    expect(ctx.getPositionList()).toHaveLength(1);

    // Next bar stays below the stop → still open.
    ctx.processBar(bar({ time: 2000, open: 100, high: 110, low: 95, close: 105 }));
    expect(ctx.getPositionList()).toHaveLength(1);
    expect(ctx.getResult().tradeList).toHaveLength(0);
  });
});
