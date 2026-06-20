import { describe, it, expect } from "vitest";
import { LiveStrategyRunner } from "../src/live";
import type {
  CancelEntryOrderArgs,
  CancelProtectiveOrderArgs,
  ClosePositionMarketArgs,
  ClosePositionMarketResult,
  LiveExecutionPort,
  OpenPositionMarketArgs,
  OpenPositionMarketResult,
  PlaceEntryOrderArgs,
  ReplaceProtectiveOrderArgs,
} from "../src/live";
import type { Bar, FilledOrder, Strategy } from "../src";

interface PortCall {
  method: string;
  args: PlaceEntryOrderArgs | CancelEntryOrderArgs | ReplaceProtectiveOrderArgs | CancelProtectiveOrderArgs | ClosePositionMarketArgs;
}

class FakeExecutionPort implements LiveExecutionPort {
  callList: PortCall[] = [];
  private nextId = 1;

  async placeEntryOrder(args: PlaceEntryOrderArgs): Promise<string | null> {
    this.callList.push({ method: "placeEntryOrder", args });
    return `ex_${this.nextId++}`;
  }

  async cancelEntryOrder(args: CancelEntryOrderArgs): Promise<boolean> {
    this.callList.push({ method: "cancelEntryOrder", args });
    return true;
  }

  async replaceStopLoss(args: ReplaceProtectiveOrderArgs): Promise<string | null> {
    this.callList.push({ method: "replaceStopLoss", args });
    return `exsl_${this.nextId++}`;
  }

  async cancelStopLoss(args: CancelProtectiveOrderArgs): Promise<boolean> {
    this.callList.push({ method: "cancelStopLoss", args });
    return true;
  }

  async replaceTakeProfit(args: ReplaceProtectiveOrderArgs): Promise<string | null> {
    this.callList.push({ method: "replaceTakeProfit", args });
    return `extp_${this.nextId++}`;
  }

  async cancelTakeProfit(args: CancelProtectiveOrderArgs): Promise<boolean> {
    this.callList.push({ method: "cancelTakeProfit", args });
    return true;
  }

  async closePositionMarket(args: ClosePositionMarketArgs): Promise<ClosePositionMarketResult | null> {
    this.callList.push({ method: "closePositionMarket", args });
    return { exitPrice: 100 };
  }

  callsOf(method: string): PortCall[] {
    return this.callList.filter((call) => call.method === method);
  }
}

// A port that additionally implements the optional openPositionMarket hook, so live market entries
// (openLong/openShort) are supported.
class MarketCapablePort extends FakeExecutionPort {
  marketEntryArgsList: OpenPositionMarketArgs[] = [];

  async openPositionMarket(args: OpenPositionMarketArgs): Promise<OpenPositionMarketResult | null> {
    this.marketEntryArgsList.push(args);
    return { exchangeOrderId: "exm_1", entryPrice: 100 };
  }
}

function makeBar(time: number, close = 100): Bar {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 100 };
}

function makeLadderStrategy(overrides?: Partial<Strategy>): Strategy {
  return {
    name: "ladder",
    version: "1.0",
    params: {},
    onBar() {},
    ...overrides,
  };
}

describe("LiveStrategyRunner", () => {
  it("places entry orders through the port after the bar and maps exchange ids", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          env.placeLimitOrder("buy", 90, 1000);
        }
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));

    expect(port.callsOf("placeEntryOrder")).toHaveLength(2);

    const orderStateList = runner.getEntryOrderStateList();

    expect(orderStateList.map((order) => order.exchangeOrderId)).toEqual(["ex_1", "ex_2"]);
    expect(runner.getPendingOrderList()).toHaveLength(2);
  });

  it("attributes an entry fill to the supplied forming fill bar (live off-by-one fix), falling back to currentBar", async () => {
    const port = new FakeExecutionPort();
    const capturedFillList: FilledOrder[] = [];
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          env.placeLimitOrder("buy", 90, 1000);
        }
      },
      onOrderFill(order) {
        capturedFillList.push(order);
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));

    // currentBar is the CLOSED bar at 1000, but the limit physically fills during the forming bar at 2000.
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1", fillBar: { openTimestamp: 2000, high: 150, low: 90 } });

    expect(capturedFillList).toHaveLength(1);
    expect(capturedFillList[0]).toMatchObject({ fillTime: 2000, fillBarOpenTimestamp: 2000, fillBarHigh: 150, fillBarLow: 90 });
    expect(runner.getPositionStateList()[0].entryTime).toBe(2000);

    // No fillBar → falls back to the runner's currentBar (1000) and leaves the fillBar* fields unset.
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_2" });

    expect(capturedFillList).toHaveLength(2);
    expect(capturedFillList[1].fillTime).toBe(1000);
    expect(capturedFillList[1].fillBarOpenTimestamp).toBeUndefined();
  });

  it("aggregates per-position stop-losses into one exchange stop-loss", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          env.placeLimitOrder("buy", 90, 1000);
          return;
        }

        const positionList = env.getPositionList();

        if (positionList.length === 2 && positionList[0].stopLoss === undefined) {
          for (const position of positionList) {
            env.setStopLoss(position.id, 95);
          }
        }
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_2" });

    expect(runner.getPositionStateList()).toHaveLength(2);

    await runner.feedClosedBar(makeBar(2000));

    const replaceCallList = port.callsOf("replaceStopLoss");

    expect(replaceCallList).toHaveLength(1);

    const replaceArgs = replaceCallList[0].args as ReplaceProtectiveOrderArgs;

    expect(replaceArgs.price).toBe(95);
    expect(replaceArgs.contracts).toBeCloseTo(1000 / 100 + 1000 / 90, 9);
    expect(replaceArgs.previousExchangeOrderId).toBeNull();
    expect(runner.getStopLossExchangeOrderId()).toBe("exsl_3");
  });

  it("trails the stop-loss by replacing the previous exchange order", async () => {
    const port = new FakeExecutionPort();
    let slLevel = 95;
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          return;
        }

        for (const position of env.getPositionList()) {
          env.setStopLoss(position.id, slLevel);
        }
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.feedClosedBar(makeBar(2000));

    slLevel = 97;
    await runner.feedClosedBar(makeBar(3000));

    const replaceCallList = port.callsOf("replaceStopLoss");

    expect(replaceCallList).toHaveLength(2);
    expect((replaceCallList[1].args as ReplaceProtectiveOrderArgs).previousExchangeOrderId).toBe("exsl_2");
    expect((replaceCallList[1].args as ReplaceProtectiveOrderArgs).price).toBe(97);
  });

  it("delivers a stop fill per position and clears the books", async () => {
    const port = new FakeExecutionPort();
    const stopFillList: FilledOrder[] = [];
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          env.placeLimitOrder("buy", 90, 1000);
          return;
        }

        for (const position of env.getPositionList()) {
          if (position.stopLoss === undefined) env.setStopLoss(position.id, 95);
        }
      },
      onOrderFill(order) {
        if (order.type === "stop") stopFillList.push(order);
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_2" });
    await runner.feedClosedBar(makeBar(2000));
    await runner.handleStopLossFilled({ price: 95 });

    expect(stopFillList).toHaveLength(2);
    expect(stopFillList.every((order) => order.price === 95)).toBe(true);
    expect(runner.getPositionStateList()).toHaveLength(0);
    expect(runner.getStopLossExchangeOrderId()).toBeNull();
    expect(port.callsOf("cancelStopLoss")).toHaveLength(0);
  });

  it("take-profit fill closes silently without onOrderFill", async () => {
    const port = new FakeExecutionPort();
    const fillTypeList: string[] = [];
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          return;
        }

        for (const position of env.getPositionList()) {
          if (position.takeProfit === undefined) env.setTakeProfit?.(position.id, 110);
        }
      },
      onOrderFill(order) {
        fillTypeList.push(order.type);
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.feedClosedBar(makeBar(2000));

    expect(port.callsOf("replaceTakeProfit")).toHaveLength(1);

    await runner.handleTakeProfitFilled({ price: 110 });

    expect(fillTypeList).toEqual(["limit"]);
    expect(runner.getPositionStateList()).toHaveLength(0);
    expect(runner.getTakeProfitExchangeOrderId()).toBeNull();
  });

  it("cancelOrder routes to the port and removes the pending order", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          return;
        }

        for (const order of env.getPendingOrderList()) {
          env.cancelOrder(order.id);
        }
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.feedClosedBar(makeBar(2000));

    const cancelCallList = port.callsOf("cancelEntryOrder");

    expect(cancelCallList).toHaveLength(1);
    expect((cancelCallList[0].args as CancelEntryOrderArgs).exchangeOrderId).toBe("ex_1");
    expect(runner.getPendingOrderList()).toHaveLength(0);
  });

  it("catch-up suppresses port calls and syncs only the final desired state", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          env.placeLimitOrder("buy", 90, 1000);
          return;
        }

        if (env.getBarIndex() === 1) {
          const firstOrder = env.getPendingOrderList()[0];

          env.cancelOrder(firstOrder.id);
          env.placeLimitOrder("buy", 80, 1000);
        }
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    runner.startCatchUp();
    await runner.feedClosedBar(makeBar(1000));
    await runner.feedClosedBar(makeBar(2000));

    expect(port.callList).toHaveLength(0);

    await runner.completeCatchUp();

    expect(port.callsOf("cancelEntryOrder")).toHaveLength(0);

    const placeCallList = port.callsOf("placeEntryOrder");

    expect(placeCallList).toHaveLength(2);
    expect(placeCallList.map((call) => (call.args as PlaceEntryOrderArgs).price)).toEqual([90, 80]);
  });

  it("aggregates position closes into one market close and cancels the protective orders", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          env.placeLimitOrder("buy", 90, 1000);
          return;
        }

        if (env.getBarIndex() === 1) {
          for (const position of env.getPositionList()) {
            env.setStopLoss(position.id, 95);
          }

          return;
        }

        env.closeAllPositions("exit_timeout");
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_2" });
    await runner.feedClosedBar(makeBar(2000));
    await runner.feedClosedBar(makeBar(3000));

    const closeCallList = port.callsOf("closePositionMarket");

    expect(closeCallList).toHaveLength(1);
    expect((closeCallList[0].args as ClosePositionMarketArgs).contracts).toBeCloseTo(1000 / 100 + 1000 / 90, 9);
    expect(port.callsOf("cancelStopLoss")).toHaveLength(1);
    expect(runner.getPositionStateList()).toHaveLength(0);
  });

  it("external close cancels protective orders and empties the books", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          return;
        }

        for (const position of env.getPositionList()) {
          if (position.stopLoss === undefined) env.setStopLoss(position.id, 95);
        }
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.feedClosedBar(makeBar(2000));
    await runner.handleExternalPositionClose();

    expect(port.callsOf("cancelStopLoss")).toHaveLength(1);
    expect(runner.getPositionStateList()).toHaveLength(0);
    expect(runner.getStopLossExchangeOrderId()).toBeNull();
  });

  it("sendCommand forwards an external command to the strategy and the strategy acts on the next bar", async () => {
    const port = new FakeExecutionPort();
    const receivedCommandList: Array<Record<string, unknown>> = [];
    let isHoldRequested = false;
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          return;
        }

        if (env.getBarIndex() === 2 && !isHoldRequested) {
          env.closeAllPositions("sideways_auto_close");
        }
      },
      onExternalCommand(command) {
        receivedCommandList.push(command);
        isHoldRequested = command.type === "sideways_hold";
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.feedClosedBar(makeBar(2000));
    await runner.sendCommand({ type: "sideways_hold", direction: "long" });
    await runner.feedClosedBar(makeBar(3000));

    expect(receivedCommandList).toEqual([{ type: "sideways_hold", direction: "long" }]);
    expect(port.callsOf("closePositionMarket")).toHaveLength(0);
    expect(runner.getPositionStateList()).toHaveLength(1);
  });

  it("sendCommand is a no-op for strategies without onExternalCommand", async () => {
    const port = new FakeExecutionPort();
    const runner = new LiveStrategyRunner(makeLadderStrategy(), { port });

    await runner.feedClosedBar(makeBar(1000));
    await expect(runner.sendCommand({ type: "sideways_hold" })).resolves.toBeUndefined();
  });

  it("snapshot/restore round-trips the books and the strategy state", async () => {
    const port = new FakeExecutionPort();
    let strategyCounter = 0;
    let restoredSnapshot: Record<string, unknown> | null = null;
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          strategyCounter = 7;
          env.placeLimitOrder("buy", 100, 1000);
        }
      },
      getStateSnapshot() {
        return { strategyCounter };
      },
      restoreStateSnapshot(snapshot) {
        restoredSnapshot = snapshot;
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });

    const snapshot = runner.getSnapshot();

    expect(snapshot.strategySnapshot).toEqual({ strategyCounter: 7 });
    expect(snapshot.positionList).toHaveLength(1);

    const secondPort = new FakeExecutionPort();
    const secondRunner = new LiveStrategyRunner(strategy, { port: secondPort });

    secondRunner.restoreSnapshot(snapshot);

    expect(restoredSnapshot).toEqual({ strategyCounter: 7 });
    expect(secondRunner.getPositionStateList()).toEqual(snapshot.positionList);
    expect(secondRunner.getEntryOrderStateList()).toEqual(snapshot.entryOrderList);
    expect(secondPort.callList).toHaveLength(0);
  });

  it("openLong opens a real market position through the port's openPositionMarket", async () => {
    const port = new MarketCapablePort();
    const fillList: FilledOrder[] = [];
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) env.openLong(1000);
      },
      onOrderFill(order) {
        fillList.push(order);
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));

    expect(port.marketEntryArgsList).toEqual([{ side: "buy", amountUsd: 1000 }]);
    expect(runner.getPositionStateList()).toHaveLength(1);
    expect(fillList).toHaveLength(1);
    expect(fillList[0].type).toBe("market");
  });

  it("openLong throws when the port does not implement openPositionMarket (no silent drop)", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) env.openLong(1000);
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await expect(runner.feedClosedBar(makeBar(1000))).rejects.toThrow(/openPositionMarket/);
    expect(runner.getPositionStateList()).toHaveLength(0);
  });

  it("snapshot/restore round-trips bar history and current bar (getHistory/getCurrentBar work after restore)", async () => {
    const port = new FakeExecutionPort();
    const runner = new LiveStrategyRunner(makeLadderStrategy(), { port });

    await runner.feedClosedBar(makeBar(1000, 100));
    await runner.feedClosedBar(makeBar(2000, 101));
    await runner.feedClosedBar(makeBar(3000, 102));

    expect(runner.getHistory(10).map((bar) => bar.time)).toEqual([1000, 2000]);
    expect(runner.getCurrentBar().time).toBe(3000);

    const snapshot = runner.getSnapshot();
    const restored = new LiveStrategyRunner(makeLadderStrategy(), { port: new FakeExecutionPort() });

    restored.restoreSnapshot(snapshot);

    expect(() => restored.getCurrentBar()).not.toThrow();
    expect(restored.getCurrentBar().time).toBe(3000);
    expect(restored.getHistory(10).map((bar) => bar.time)).toEqual([1000, 2000]);
  });

  it("re-feeding already-incorporated bars after restore is idempotent (no doubled history, no index drift)", async () => {
    const port = new FakeExecutionPort();
    const runner = new LiveStrategyRunner(makeLadderStrategy(), { port });

    await runner.feedClosedBar(makeBar(1000, 100));
    await runner.feedClosedBar(makeBar(2000, 101));
    await runner.feedClosedBar(makeBar(3000, 102));

    const snapshot = runner.getSnapshot();
    const restored = new LiveStrategyRunner(makeLadderStrategy(), { port: new FakeExecutionPort() });

    restored.restoreSnapshot(snapshot);

    const indexAfterRestore = restored.getBarIndex();

    // The host replays already-seen klines (time <= current) after restore — they must be skipped.
    restored.catchUpBar(makeBar(2000, 101));
    restored.catchUpBar(makeBar(3000, 102));

    expect(restored.getHistory(10).map((bar) => bar.time)).toEqual([1000, 2000]);
    expect(restored.getBarIndex()).toBe(indexAfterRestore);
    expect(restored.getCurrentBar().time).toBe(3000);

    // A genuinely new closed bar (time > current) advances normally.
    await restored.feedClosedBar(makeBar(4000, 103));

    expect(restored.getHistory(10).map((bar) => bar.time)).toEqual([1000, 2000, 3000]);
    expect(restored.getCurrentBar().time).toBe(4000);
  });

  it("restoring a legacy snapshot without bar context stays backward-compatible (history empty, getCurrentBar throws)", async () => {
    const port = new FakeExecutionPort();
    const runner = new LiveStrategyRunner(makeLadderStrategy(), { port });

    await runner.feedClosedBar(makeBar(1000, 100));

    const snapshot = runner.getSnapshot();
    // Simulate a snapshot persisted by an older SDK that did not carry bar context.
    const legacySnapshot = { ...snapshot };

    delete legacySnapshot.barHistory;
    delete legacySnapshot.oiHistory;
    delete legacySnapshot.currentBar;
    delete legacySnapshot.currentMaValues;
    delete legacySnapshot.currentOiBar;

    const restored = new LiveStrategyRunner(makeLadderStrategy(), { port: new FakeExecutionPort() });

    restored.restoreSnapshot(legacySnapshot);

    expect(restored.getHistory(10)).toEqual([]);
    expect(() => restored.getCurrentBar()).toThrow(/No current bar/);
  });
});
