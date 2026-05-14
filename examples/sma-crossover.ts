import { defineStrategy } from "../src";

interface SmaCrossoverParams extends Record<string, number> {
  fastPeriod: number;
  slowPeriod: number;
  positionSize: number;
}

export default defineStrategy<SmaCrossoverParams>({
  name: "SMA Crossover",
  version: "1.0",
  params: { fastPeriod: 9, slowPeriod: 21, positionSize: 100 },
  onBar(bar, _maValues, env) {
    const slowPeriod = env.getParam("slowPeriod", 21);
    const fastPeriod = env.getParam("fastPeriod", 9);
    const positionSize = env.getParam("positionSize", 100);

    const history = env.getHistory(slowPeriod);
    if (history.length < slowPeriod) return;

    const slowSma = avg(history.map((b) => b.close));
    const fastSma = avg(history.slice(-fastPeriod).map((b) => b.close));
    const position = env.getPosition();

    if (fastSma > slowSma && !position) {
      env.openLong(positionSize);
    } else if (fastSma < slowSma && position?.side === "long") {
      env.closeLong();
    }
  },
});

function avg(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
