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
  PlaceEntryOrderResult,
  ReplaceProtectiveOrderArgs,
  ReplaceProtectiveOrderResult,
} from "../src/live";
import type { Bar, FilledOrder, Strategy } from "../src";

interface PortCall {
  method: string;
  args: PlaceEntryOrderArgs | CancelEntryOrderArgs | ReplaceProtectiveOrderArgs | CancelProtectiveOrderArgs | ClosePositionMarketArgs;
}

class FakeExecutionPort implements LiveExecutionPort {
  callList: PortCall[] = [];
  private nextId = 1;

  async placeEntryOrder(args: PlaceEntryOrderArgs): Promise<PlaceEntryOrderResult | null> {
    this.callList.push({ method: "placeEntryOrder", args });
    return { exchangeOrderId: `ex_${this.nextId++}` };
  }

  async cancelEntryOrder(args: CancelEntryOrderArgs): Promise<boolean> {
    this.callList.push({ method: "cancelEntryOrder", args });
    return true;
  }

  async replaceStopLoss(args: ReplaceProtectiveOrderArgs): Promise<ReplaceProtectiveOrderResult | null> {
    this.callList.push({ method: "replaceStopLoss", args });
    return { exchangeOrderIdList: [`exsl_${this.nextId++}`], isComplete: true };
  }

  async cancelStopLoss(args: CancelProtectiveOrderArgs): Promise<boolean> {
    this.callList.push({ method: "cancelStopLoss", args });
    return true;
  }

  async replaceTakeProfit(args: ReplaceProtectiveOrderArgs): Promise<ReplaceProtectiveOrderResult | null> {
    this.callList.push({ method: "replaceTakeProfit", args });
    return { exchangeOrderIdList: [`extp_${this.nextId++}`], isComplete: true };
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

  it("sizes the position from filledAmountUsd when given (partial fill), else the full order amount", async () => {
    const port = new FakeExecutionPort();
    const capturedFillList: FilledOrder[] = [];
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          env.placeLimitOrder("buy", 50, 1000);
        }
      },
      onOrderFill(order) {
        capturedFillList.push(order);
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));

    // Partial fill crystallized by the engine: only 800 USD of the 1000 USD order actually filled.
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1", filledAmountUsd: 800 });

    const partial = runner.getPositionStateList()[0];
    expect(partial.amountUsd).toBe(800);
    expect(partial.contracts).toBe(800 / 100);
    expect(capturedFillList[0].amountUsd).toBe(800);

    // No filledAmountUsd → full order amount (backtest/paper + full live fills).
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_2" });

    const full = runner.getPositionStateList()[1];
    expect(full.amountUsd).toBe(1000);
    expect(full.contracts).toBe(1000 / 50);
    expect(capturedFillList[1].amountUsd).toBe(1000);
  });

  it("books the position at the exchange's average fill price when supplied, else the limit target", async () => {
    const port = new FakeExecutionPort();
    const capturedFillList: FilledOrder[] = [];
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("sell", 103, 100);
          env.placeLimitOrder("sell", 106, 100);
        }
      },
      onOrderFill(order) {
        capturedFillList.push(order);
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));

    // The market ran past the level: the resting 103 limit filled at an average of 103.5. The book
    // must carry the exchange's real entry — the target drifts every entry-anchored level (stops,
    // takes, journal averages; the ESPORTSUSDT 19.07 case).
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1", avgFillPrice: 103.5 });

    const booked = runner.getPositionStateList()[0];
    expect(booked.entryPrice).toBe(103.5);
    expect(booked.contracts).toBeCloseTo(100 / 103.5, 9);
    expect(capturedFillList[0].price).toBe(103.5);

    // No average supplied (backtest/paper semantics) → the limit price stands.
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_2" });

    expect(runner.getPositionStateList()[1].entryPrice).toBe(106);
    expect(capturedFillList[1].price).toBe(106);
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
    expect(replaceArgs.previousExchangeOrderIdList).toEqual([]);
    expect(runner.getStopLossExchangeOrderIdList()).toEqual(["exsl_3"]);
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
    expect((replaceCallList[1].args as ReplaceProtectiveOrderArgs).previousExchangeOrderIdList).toEqual(["exsl_2"]);
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
    expect(runner.getStopLossExchangeOrderIdList()).toEqual([]);
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
    expect(runner.getTakeProfitExchangeOrderIdList()).toEqual([]);
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

  it("keeps a placed order in the book when the exchange REJECTS the cancel, and retries next sync", async () => {
    // The port refuses the first cancel attempt (network failure / exchange error), accepts the second.
    class FlakyCancelPort extends FakeExecutionPort {
      private cancelAttemptCount = 0;

      override async cancelEntryOrder(args: CancelEntryOrderArgs): Promise<boolean> {
        this.callList.push({ method: "cancelEntryOrder", args });

        return ++this.cancelAttemptCount > 1;
      }
    }

    const port = new FlakyCancelPort();
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
    await runner.feedClosedBar(makeBar(2000)); // cancel attempt 1 — rejected

    // The order MUST stay tracked: its fill would otherwise open an unmanaged exchange position.
    expect(runner.getPendingOrderList()).toHaveLength(1);
    expect(runner.getEntryOrderStateList()[0].isCancelRequested).toBe(true);

    await runner.feedClosedBar(makeBar(3000)); // cancel attempt 2 — accepted

    expect(port.callsOf("cancelEntryOrder")).toHaveLength(2);
    expect(runner.getPendingOrderList()).toHaveLength(0);
  });

  it("routes a fill that RACES a pending cancel (the order is still in the book)", async () => {
    class NeverCancelPort extends FakeExecutionPort {
      override async cancelEntryOrder(args: CancelEntryOrderArgs): Promise<boolean> {
        this.callList.push({ method: "cancelEntryOrder", args });

        return false;
      }
    }

    const port = new NeverCancelPort();
    const fillList: FilledOrder[] = [];
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
      onOrderFill(order) {
        fillList.push(order);
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.feedClosedBar(makeBar(2000)); // cancel requested, exchange refuses it

    // The exchange filled the order before any later cancel succeeded — the fill must still route.
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });

    expect(fillList).toHaveLength(1);
    expect(runner.getPositionStateList()).toHaveLength(1);
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
    expect(runner.getStopLossExchangeOrderIdList()).toEqual([]);
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

  it("stores a multi-piece protective set and passes it back as the previous set on the next replace", async () => {
    class SplittingPort extends FakeExecutionPort {
      private replaceCount = 0;

      override async replaceStopLoss(args: ReplaceProtectiveOrderArgs): Promise<ReplaceProtectiveOrderResult | null> {
        this.callList.push({ method: "replaceStopLoss", args });
        this.replaceCount++;

        return { exchangeOrderIdList: [`exsl_${this.replaceCount}a`, `exsl_${this.replaceCount}b`], isComplete: true };
      }
    }

    const port = new SplittingPort();
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

    expect(runner.getStopLossExchangeOrderIdList()).toEqual(["exsl_1a", "exsl_1b"]);

    slLevel = 97;
    await runner.feedClosedBar(makeBar(3000));

    const replaceCallList = port.callsOf("replaceStopLoss");

    expect(replaceCallList).toHaveLength(2);
    expect((replaceCallList[1].args as ReplaceProtectiveOrderArgs).previousExchangeOrderIdList).toEqual(["exsl_1a", "exsl_1b"]);
    expect(runner.getStopLossExchangeOrderIdList()).toEqual(["exsl_2a", "exsl_2b"]);
  });

  it("an incomplete replace keeps the runner unsynced: ids are stored, the next sync retries with them", async () => {
    class PartialPort extends FakeExecutionPort {
      private replaceCount = 0;

      override async replaceStopLoss(args: ReplaceProtectiveOrderArgs): Promise<ReplaceProtectiveOrderResult | null> {
        this.callList.push({ method: "replaceStopLoss", args });
        this.replaceCount++;

        if (this.replaceCount === 1) {
          return { exchangeOrderIdList: ["exsl_partial"], isComplete: false };
        }

        return { exchangeOrderIdList: ["exsl_full_a", "exsl_full_b"], isComplete: true };
      }
    }

    const port = new PartialPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          return;
        }

        for (const position of env.getPositionList()) {
          env.setStopLoss(position.id, 95);
        }
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.feedClosedBar(makeBar(2000));

    expect(runner.getStopLossExchangeOrderIdList()).toEqual(["exsl_partial"]);

    // Desired state unchanged, but the incomplete result forces a retry that cancels the partial set.
    await runner.feedClosedBar(makeBar(3000));

    const replaceCallList = port.callsOf("replaceStopLoss");

    expect(replaceCallList).toHaveLength(2);
    expect((replaceCallList[1].args as ReplaceProtectiveOrderArgs).previousExchangeOrderIdList).toEqual(["exsl_partial"]);
    expect(runner.getStopLossExchangeOrderIdList()).toEqual(["exsl_full_a", "exsl_full_b"]);

    // Complete now — no further replace at the same desired state.
    await runner.feedClosedBar(makeBar(4000));

    expect(port.callsOf("replaceStopLoss")).toHaveLength(2);
  });

  it("a null replace keeps the previous set untouched and retries next sync", async () => {
    class RejectingPort extends FakeExecutionPort {
      private replaceCount = 0;

      override async replaceStopLoss(args: ReplaceProtectiveOrderArgs): Promise<ReplaceProtectiveOrderResult | null> {
        this.callList.push({ method: "replaceStopLoss", args });
        this.replaceCount++;

        return this.replaceCount === 1 ? null : { exchangeOrderIdList: ["exsl_ok"], isComplete: true };
      }
    }

    const port = new RejectingPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          return;
        }

        for (const position of env.getPositionList()) {
          env.setStopLoss(position.id, 95);
        }
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.feedClosedBar(makeBar(2000));

    expect(runner.getStopLossExchangeOrderIdList()).toEqual([]);

    await runner.feedClosedBar(makeBar(3000));

    expect(port.callsOf("replaceStopLoss")).toHaveLength(2);
    expect(runner.getStopLossExchangeOrderIdList()).toEqual(["exsl_ok"]);
  });

  it("cancel sends the whole piece list", async () => {
    class SplittingPort extends FakeExecutionPort {
      override async replaceStopLoss(args: ReplaceProtectiveOrderArgs): Promise<ReplaceProtectiveOrderResult | null> {
        this.callList.push({ method: "replaceStopLoss", args });

        return { exchangeOrderIdList: ["exsl_a", "exsl_b"], isComplete: true };
      }
    }

    const port = new SplittingPort();
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

    const cancelCallList = port.callsOf("cancelStopLoss");

    expect(cancelCallList).toHaveLength(1);
    expect((cancelCallList[0].args as CancelProtectiveOrderArgs).exchangeOrderIdList).toEqual(["exsl_a", "exsl_b"]);
  });

  it("stores the exit-reason codes from setStopLoss/setTakeProfit and clears them on the fills", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          return;
        }

        for (const position of env.getPositionList()) {
          if (position.stopLoss === undefined) {
            env.setStopLoss(position.id, 95, "retrace_stop|25");
            env.setTakeProfit?.(position.id, 110, "take_profit_ma200");
          }
        }
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.feedClosedBar(makeBar(2000));

    expect(runner.getDesiredStopLossReason()).toBe("retrace_stop|25");
    expect(runner.getDesiredTakeProfitReason()).toBe("take_profit_ma200");

    await runner.handleStopLossFilled({ price: 95 });

    expect(runner.getDesiredStopLossReason()).toBeNull();
    expect(runner.getDesiredTakeProfitReason()).toBeNull();
  });

  it("clears the exit-reason codes when the book empties through closePosition", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          return;
        }

        if (env.getBarIndex() === 1) {
          for (const position of env.getPositionList()) {
            env.setStopLoss(position.id, 95, "trail_stop|4");
          }

          return;
        }

        env.closeAllPositions("max_hold|80");
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.feedClosedBar(makeBar(2000));

    expect(runner.getDesiredStopLossReason()).toBe("trail_stop|4");

    await runner.feedClosedBar(makeBar(3000));

    expect(runner.getDesiredStopLossReason()).toBeNull();
  });

  it("setProtectiveSyncHold freezes replace placements but not cancels; release resumes", async () => {
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
          if (position.takeProfit === undefined) env.setTakeProfit?.(position.id, 110);
        }
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.feedClosedBar(makeBar(2000));

    expect(port.callsOf("replaceStopLoss")).toHaveLength(1);

    runner.setProtectiveSyncHold(true);
    slLevel = 97;
    await runner.feedClosedBar(makeBar(3000));

    expect(port.callsOf("replaceStopLoss")).toHaveLength(1);

    // The cancel branch still runs while held: a stop fill must cancel the orphaned take-profit set.
    await runner.handleStopLossFilled({ price: 97 });

    expect(port.callsOf("cancelTakeProfit")).toHaveLength(1);

    runner.setProtectiveSyncHold(false);
  });

  it("invalidateProtectiveSync forces a re-place at the unchanged desired values", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          return;
        }

        for (const position of env.getPositionList()) {
          env.setStopLoss(position.id, 95);
        }
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.feedClosedBar(makeBar(2000));
    await runner.feedClosedBar(makeBar(3000));

    expect(port.callsOf("replaceStopLoss")).toHaveLength(1);

    runner.invalidateProtectiveSync();
    await runner.feedClosedBar(makeBar(4000));

    expect(port.callsOf("replaceStopLoss")).toHaveLength(2);
  });

  it("snapshot round-trips the protective piece lists and reasons; a pre-2.0 scalar snapshot restores as one-element lists", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          return;
        }

        for (const position of env.getPositionList()) {
          if (position.stopLoss === undefined) env.setStopLoss(position.id, 95, "lock_stop");
        }
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.feedClosedBar(makeBar(2000));

    const snapshot = runner.getSnapshot();

    expect(snapshot.stopLossExchangeOrderIdList).toEqual(["exsl_2"]);
    expect(snapshot.desiredStopLossReason).toBe("lock_stop");

    const restored = new LiveStrategyRunner(makeLadderStrategy(), { port: new FakeExecutionPort() });

    restored.restoreSnapshot(snapshot);

    expect(restored.getStopLossExchangeOrderIdList()).toEqual(["exsl_2"]);
    expect(restored.getDesiredStopLossReason()).toBe("lock_stop");

    // A pre-2.0 snapshot carries scalar id fields instead of the lists.
    const legacySnapshot = { ...snapshot, stopLossExchangeOrderId: "legacy_sl", takeProfitExchangeOrderId: null };

    delete legacySnapshot.stopLossExchangeOrderIdList;
    delete legacySnapshot.takeProfitExchangeOrderIdList;
    delete legacySnapshot.desiredStopLossReason;

    const legacyRestored = new LiveStrategyRunner(makeLadderStrategy(), { port: new FakeExecutionPort() });

    legacyRestored.restoreSnapshot(legacySnapshot);

    expect(legacyRestored.getStopLossExchangeOrderIdList()).toEqual(["legacy_sl"]);
    expect(legacyRestored.getTakeProfitExchangeOrderIdList()).toEqual([]);
    expect(legacyRestored.getDesiredStopLossReason()).toBeNull();
  });

  it("books one entry order per cap piece when the port splits the notional, and each piece lives the full lifecycle", async () => {
    class EntrySplittingPort extends FakeExecutionPort {
      splitEntryNotionalUsd(args: { price: number; amountUsd: number }): number[] {
        return args.amountUsd > 600 ? [600, args.amountUsd - 600] : [args.amountUsd];
      }
    }

    const port = new EntrySplittingPort();
    const fillList: FilledOrder[] = [];
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
        }
      },
      onOrderFill(order) {
        fillList.push(order);
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));

    // The 1000 USD rung books as two pieces (600 + 400), each placed as its own exchange order.
    const placeCallList = port.callsOf("placeEntryOrder");

    expect(placeCallList).toHaveLength(2);
    expect(placeCallList.map((call) => (call.args as PlaceEntryOrderArgs).amountUsd)).toEqual([600, 400]);
    expect(runner.getPendingOrderList()).toHaveLength(2);

    // Each piece fill books its own position sized by the piece, not by the logical rung.
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_2" });

    expect(runner.getPositionStateList().map((position) => position.amountUsd)).toEqual([600, 400]);
    expect(fillList.map((order) => order.amountUsd)).toEqual([600, 400]);
  });

  it("cancels every entry piece through the ordinary pending-list iteration (the strategy's cancel pattern)", async () => {
    class EntrySplittingPort extends FakeExecutionPort {
      splitEntryNotionalUsd(args: { price: number; amountUsd: number }): number[] {
        return [args.amountUsd / 2, args.amountUsd / 2];
      }
    }

    const port = new EntrySplittingPort();
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

    expect(port.callsOf("cancelEntryOrder")).toHaveLength(2);
    expect(runner.getPendingOrderList()).toHaveLength(0);
  });

  it("keeps a REDUCED entry landing and immediately places the shortfall in the same sync", async () => {
    class ReducingPort extends FakeExecutionPort {
      private placeCount = 0;

      override async placeEntryOrder(args: PlaceEntryOrderArgs): Promise<PlaceEntryOrderResult | null> {
        this.callList.push({ method: "placeEntryOrder", args });
        this.placeCount++;

        // The first landing is accepted reduced (600 of 1000); the shortfall lands in full.
        return this.placeCount === 1
          ? { exchangeOrderId: "ex_reduced", acceptedAmountUsd: 600 }
          : { exchangeOrderId: `ex_top_${this.placeCount}` };
      }
    }

    const port = new ReducingPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) env.placeLimitOrder("buy", 100, 1000);
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));

    const placeCallList = port.callsOf("placeEntryOrder");

    expect(placeCallList).toHaveLength(2);
    expect((placeCallList[0].args as PlaceEntryOrderArgs).amountUsd).toBe(1000);
    expect((placeCallList[1].args as PlaceEntryOrderArgs).amountUsd).toBe(400);

    const orderStateList = runner.getEntryOrderStateList();

    expect(orderStateList.map((order) => ({ amountUsd: order.amountUsd, exchangeOrderId: order.exchangeOrderId }))).toEqual([
      { amountUsd: 600, exchangeOrderId: "ex_reduced" },
      { amountUsd: 400, exchangeOrderId: "ex_top_2" },
    ]);
  });

  it("bounds the top-up passes when the exchange keeps reducing (leftover retries next sync)", async () => {
    class AlwaysReducingPort extends FakeExecutionPort {
      private placeCount = 0;

      override async placeEntryOrder(args: PlaceEntryOrderArgs): Promise<PlaceEntryOrderResult | null> {
        this.callList.push({ method: "placeEntryOrder", args });
        this.placeCount++;

        return { exchangeOrderId: `ex_${this.placeCount}`, acceptedAmountUsd: args.amountUsd / 2 };
      }
    }

    const port = new AlwaysReducingPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) env.placeLimitOrder("buy", 100, 1000);
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));

    // Three passes placed 1000, 500 and 250 (each accepted halved); the 125 leftover stays booked
    // for the next sync instead of looping forever.
    expect(port.callsOf("placeEntryOrder")).toHaveLength(3);

    const unplacedList = runner.getEntryOrderStateList().filter((order) => order.exchangeOrderId === null);

    expect(unplacedList).toHaveLength(1);
    expect(unplacedList[0].amountUsd).toBeCloseTo(125, 9);
  });

  it("falls back to the unsplit notional when the port returns an empty split", async () => {
    class RefusingSplitPort extends FakeExecutionPort {
      splitEntryNotionalUsd(): number[] {
        return [];
      }
    }

    const port = new RefusingSplitPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) env.placeLimitOrder("buy", 100, 1000);
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));

    expect(port.callsOf("placeEntryOrder")).toHaveLength(1);
    expect((port.callsOf("placeEntryOrder")[0].args as PlaceEntryOrderArgs).amountUsd).toBe(1000);
  });

  it("resyncProtectiveOrders re-places the protective set immediately, without waiting for a bar", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("buy", 100, 1000);
          return;
        }

        for (const position of env.getPositionList()) {
          env.setStopLoss(position.id, 95);
        }
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.feedClosedBar(makeBar(2000));

    expect(port.callsOf("replaceStopLoss")).toHaveLength(1);

    await runner.resyncProtectiveOrders();

    expect(port.callsOf("replaceStopLoss")).toHaveLength(2);
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

  it("a fill racing into a running sync never duplicates the remaining ladder rungs (SOXLUSDT incident)", async () => {
    const port = new FakeExecutionPort();
    let fillPromise: Promise<void> | null = null;
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("sell", 100, 6000);
          env.placeLimitOrder("sell", 102, 6000);
          env.placeLimitOrder("sell", 104, 6000);
        }
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });
    const placeEntryOrder = port.placeEntryOrder.bind(port);

    port.placeEntryOrder = async (args: PlaceEntryOrderArgs) => {
      const result = await placeEntryOrder(args);

      if (args.price === 102 && fillPromise === null) {
        fillPromise = runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
      }

      return result;
    };

    await runner.feedClosedBar(makeBar(1000));
    await fillPromise;

    const placedPriceList = port.callsOf("placeEntryOrder").map((call) => (call.args as PlaceEntryOrderArgs).price);

    expect(placedPriceList).toEqual([100, 102, 104]);
  });

  it("a sync request coalesced during a running sync still materialises its desired state afterwards", async () => {
    const port = new FakeExecutionPort();
    let fillPromise: Promise<void> | null = null;
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("sell", 100, 6000);
          env.placeLimitOrder("sell", 102, 6000);
        }
      },
      onOrderFill(_order, env) {
        const positionList = env.getPositionList();

        env.setStopLoss(positionList[0].id, 110);
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });
    const placeEntryOrder = port.placeEntryOrder.bind(port);

    port.placeEntryOrder = async (args: PlaceEntryOrderArgs) => {
      const result = await placeEntryOrder(args);

      if (args.price === 102 && fillPromise === null) {
        fillPromise = runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
      }

      return result;
    };

    await runner.feedClosedBar(makeBar(1000));
    await fillPromise;

    const replaceCallList = port.callsOf("replaceStopLoss");

    expect(replaceCallList).toHaveLength(1);
    expect((replaceCallList[0].args as ReplaceProtectiveOrderArgs).price).toBe(110);
  });

  it("a stop-loss fill immediately cancels the remaining ladder rungs in the same sync", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("sell", 100, 6000);
          env.placeLimitOrder("sell", 102, 6000);
          env.placeLimitOrder("sell", 104, 6000);
        }
      },
      onOrderFill(_order, env) {
        const positionList = env.getPositionList();

        if (positionList.length > 0) env.setStopLoss(positionList[0].id, 110);
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.handleStopLossFilled({ price: 110 });

    expect(port.callsOf("cancelEntryOrder")).toHaveLength(2);
    expect(runner.getEntryOrderStateList()).toHaveLength(0);
  });

  it("a take-profit fill immediately cancels the remaining ladder rungs", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("sell", 100, 6000);
          env.placeLimitOrder("sell", 102, 6000);
        }
      },
      onOrderFill(_order, env) {
        const positionList = env.getPositionList();

        if (positionList.length > 0) env.setTakeProfit(positionList[0].id, 90);
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.handleTakeProfitFilled({ price: 90 });

    expect(port.callsOf("cancelEntryOrder")).toHaveLength(1);
    expect(runner.getEntryOrderStateList()).toHaveLength(0);
  });

  it("an external position close immediately cancels the remaining ladder rungs", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("sell", 100, 6000);
          env.placeLimitOrder("sell", 102, 6000);
        }
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.handleExternalPositionClose();

    expect(port.callsOf("cancelEntryOrder")).toHaveLength(1);
    expect(runner.getEntryOrderStateList()).toHaveLength(0);
  });

  it("a full strategy-driven close cancels the remaining ladder rungs in the same sync", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("sell", 100, 6000);
          env.placeLimitOrder("sell", 102, 6000);
          env.placeLimitOrder("sell", 104, 6000);

          return;
        }

        env.closeAllPositions("retrace_stop");
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.feedClosedBar(makeBar(2000));

    expect(port.callsOf("closePositionMarket")).toHaveLength(1);
    expect(port.callsOf("cancelEntryOrder")).toHaveLength(2);
    expect(runner.getEntryOrderStateList()).toHaveLength(0);
  });

  it("a partial strategy-driven close keeps the remaining ladder rungs", async () => {
    const port = new FakeExecutionPort();
    const strategy = makeLadderStrategy({
      onBar(_bar, _ma, env) {
        if (env.getBarIndex() === 0) {
          env.placeLimitOrder("sell", 100, 6000);
          env.placeLimitOrder("sell", 102, 6000);
          env.placeLimitOrder("sell", 104, 6000);

          return;
        }

        const positionList = env.getPositionList();

        if (positionList.length === 2) env.closePosition(positionList[0].id, "partial");
      },
    });
    const runner = new LiveStrategyRunner(strategy, { port });

    await runner.feedClosedBar(makeBar(1000));
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_1" });
    await runner.handleEntryOrderFilled({ exchangeOrderId: "ex_2" });
    await runner.feedClosedBar(makeBar(2000));

    expect(port.callsOf("cancelEntryOrder")).toHaveLength(0);
  });
});
