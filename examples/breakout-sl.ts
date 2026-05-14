import { defineStrategy } from "../src";

interface BreakoutParams extends Record<string, number> {
  lookback: number;
  slPercent: number;
  positionSize: number;
}

export default defineStrategy<BreakoutParams>({
  name: "Breakout with SL",
  version: "1.0",
  params: { lookback: 20, slPercent: 2, positionSize: 100 },
  onBar(bar, _maValues, env) {
    const lookback = env.getParam("lookback", 20);
    const slPercent = env.getParam("slPercent", 2);
    const positionSize = env.getParam("positionSize", 100);

    const history = env.getHistory(lookback);
    if (history.length < lookback) return;

    const highest = Math.max(...history.map((b) => b.high));
    const lowest = Math.min(...history.map((b) => b.low));
    const position = env.getPosition();

    if (!position && bar.close > highest) {
      const sl = bar.close * (1 - slPercent / 100);
      env.openLong(positionSize, { stopLoss: sl, tag: "breakout-up" });
      return;
    }

    if (!position && bar.close < lowest) {
      const sl = bar.close * (1 + slPercent / 100);
      env.openShort(positionSize, { stopLoss: sl, tag: "breakout-down" });
      return;
    }

    if (position?.side === "long" && bar.close < lowest) {
      env.closeLong();
    } else if (position?.side === "short" && bar.close > highest) {
      env.closeShort();
    }
  },
  onOrderFill(order, env) {
    if (order.type === "stop") {
      env.emitEvent("breakout_sl_fired", {
        positionId: order.positionId,
        entryPrice: order.entryPrice,
        runningBest: order.runningBest,
      });
    }
  },
});
