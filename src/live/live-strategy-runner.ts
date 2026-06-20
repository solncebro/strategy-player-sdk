import type {
  AuxSeriesKind,
  BacktestEvent,
  Bar,
  MaValues,
  OiOhlc,
  ParamValue,
  PendingOrder,
  Position,
  PositionOptions,
  Strategy,
  TradingEnv,
} from "../types";
import type {
  CancelEntryOrderArgs,
  EntryOrderFilledArgs,
  LiveEntryOrderState,
  LiveExecutionPort,
  LivePositionState,
  LiveRunnerSnapshot,
  LiveStrategyRunnerOptions,
  ProtectiveOrderFilledArgs,
  ProtectiveOrderSyncState,
} from "./types";
import { MARKET_CLOSE_FILLED_EVENT, MARKET_ENTRY_FILLED_EVENT } from "./types";

const ZERO_MA: MaValues = { ma25: 0, ma50: 0, ma100: 0, ma200: 0 };
const DEFAULT_HISTORY_LIMIT = 1000;

/**
 * Drives ONE strategy instance (= one symbol+direction) against a live exchange through a
 * LiveExecutionPort. The strategy sees the exact same TradingEnv contract as in the backtest player;
 * the runner translates its synchronous calls into a desired order/position state and syncs that
 * state to the exchange after every bar / fill handler ("desired-state sync").
 *
 * Aggregation: the strategy holds N small positions (one per limit fill, mirroring the backtest
 * runtime), while the exchange holds ONE netted position. Protective orders (stop-loss /
 * take-profit) therefore sync as a single exchange order covering the total size; the strategy is
 * expected to keep one uniform protective price across its positions (the last set price wins).
 *
 * Take-profit fills mirror the backtest runtime semantics: they do NOT produce onOrderFill — the
 * strategy reconciles its position list via getPosition/getPositionList on the next bar.
 *
 * Catch-up mode replays history through the strategy WITHOUT touching the exchange; completing it
 * syncs only the final desired state (used for manual late entries and restart recovery).
 */
export class LiveStrategyRunner implements TradingEnv {
  private readonly strategy: Strategy;
  private readonly port: LiveExecutionPort;
  private readonly params: Record<string, ParamValue>;
  private readonly rawConfig: Record<string, unknown>;
  private readonly onEvent?: (event: BacktestEvent) => void;
  private readonly balanceProvider?: () => number;
  private readonly historyLimit: number;

  private barHistory: Bar[] = [];
  private currentBar: Bar | null = null;
  private currentMaValues: MaValues | null = null;
  private currentBarIndex = -1;
  private oiHistory: Array<OiOhlc | null> = [];
  private currentOiBar: OiOhlc | null = null;
  private desiredMarketEntry: { side: "buy" | "sell"; amountUsd: number } | null = null;

  private entryOrderList: LiveEntryOrderState[] = [];
  private cancelRequestList: CancelEntryOrderArgs[] = [];
  private positionList: LivePositionState[] = [];
  private desiredStopLossPrice: number | null = null;
  private desiredTakeProfitPrice: number | null = null;
  private stopLossExchangeOrderId: string | null = null;
  private takeProfitExchangeOrderId: string | null = null;
  private lastSyncedStopLoss: ProtectiveOrderSyncState | null = null;
  private lastSyncedTakeProfit: ProtectiveOrderSyncState | null = null;
  private pendingCloseAmountUsd = 0;
  private pendingCloseContracts = 0;
  private nextLocalOrderNumber = 1;
  private nextLocalPositionNumber = 1;
  private isCatchUpActive = false;
  private isInitialized = false;

  constructor(strategy: Strategy, options: LiveStrategyRunnerOptions) {
    this.strategy = strategy;
    this.port = options.port;
    this.params = options.params ?? strategy.params;
    this.rawConfig = options.rawConfig ?? {};
    this.onEvent = options.onEvent;
    this.balanceProvider = options.getBalanceUsd;
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  // ---------------------------------------------------------------------- runner API

  async feedClosedBar(bar: Bar, maValues?: MaValues, oiBar?: OiOhlc): Promise<void> {
    this.ensureInitialized();

    // A bar already incorporated (time <= the last one) is skipped — no strategy run, no sync — so a
    // host that replays missed/already-seen klines after a snapshot restore does not double-process.
    if (!this.advanceBar(bar, maValues, oiBar)) return;

    this.strategy.onBar(bar, maValues ?? ZERO_MA, this);
    await this.sync();
  }

  // Replay a historical closed bar to build price/open-interest history WITHOUT running the strategy
  // and WITHOUT touching the exchange — live warmup, so a fresh start does not act on signals that
  // closed before going live. Idempotent by bar time (see advanceBar): replaying a bar already in the
  // restored history is a no-op, so restore + catch-up compose without doubling history.
  catchUpBar(bar: Bar, maValues?: MaValues, oiBar?: OiOhlc): void {
    this.ensureInitialized();
    this.advanceBar(bar, maValues, oiBar);
  }

  // Advance the rolling market context by one closed bar: push the previous bar/OI into history
  // (trimmed to historyLimit), then set the new current bar/MA/OI and update running-best. Returns
  // false (and does nothing) when the bar is at or before the last incorporated bar — the idempotency
  // guard that lets snapshot-restore and catch-up compose without doubling history or drifting the
  // bar index. Shared by feedClosedBar and catchUpBar so the two paths cannot diverge.
  private advanceBar(bar: Bar, maValues?: MaValues, oiBar?: OiOhlc): boolean {
    if (this.currentBar && bar.time <= this.currentBar.time) return false;

    if (this.currentBar) {
      this.barHistory.push(this.currentBar);
      this.oiHistory.push(this.currentOiBar);

      if (this.barHistory.length > this.historyLimit) {
        this.barHistory.splice(0, this.barHistory.length - this.historyLimit);
      }

      if (this.oiHistory.length > this.historyLimit) {
        this.oiHistory.splice(0, this.oiHistory.length - this.historyLimit);
      }
    }

    this.currentBarIndex++;
    this.currentBar = bar;
    this.currentMaValues = maValues ?? null;
    this.currentOiBar = oiBar ?? null;
    this.updateRunningBest(bar);

    return true;
  }

  // Forwards an external user command (e.g. a Telegram reply) to the strategy. The strategy is
  // expected to only mark snapshot-visible state and act on it in the next onBar; the sync afterwards
  // covers strategies that mutate the desired order state immediately.
  async sendCommand(command: Record<string, unknown>): Promise<void> {
    this.ensureInitialized();

    if (!this.strategy.onExternalCommand) return;

    this.strategy.onExternalCommand(command, this);
    await this.sync();
  }

  startCatchUp(): void {
    this.isCatchUpActive = true;
  }

  async completeCatchUp(): Promise<void> {
    this.isCatchUpActive = false;
    await this.sync();
  }

  isInCatchUp(): boolean {
    return this.isCatchUpActive;
  }

  async handleEntryOrderFilled(args: EntryOrderFilledArgs): Promise<void> {
    this.ensureInitialized();

    const order = this.entryOrderList.find((entry) => entry.exchangeOrderId === args.exchangeOrderId);

    if (!order) return;

    this.entryOrderList = this.entryOrderList.filter((entry) => entry.localOrderId !== order.localOrderId);

    // In live a limit fills mid-forming-bar, but this.currentBar is the previous CLOSED bar. The engine
    // supplies the real forming fill bar in args.fillBar so the fill is attributed to the bar it
    // physically happened on (entryTime / fillTime + the fillBar* the strategy snapshots). Without it
    // (backtest/paper, where fills are intra-bar) fall back to currentBar.
    const fillTime = args.fillBar?.openTimestamp ?? this.currentBar?.time ?? 0;

    const position: LivePositionState = {
      localPositionId: `pos_${this.nextLocalPositionNumber++}`,
      side: order.side === "buy" ? "long" : "short",
      entryPrice: order.price,
      amountUsd: order.amountUsd,
      contracts: order.amountUsd / order.price,
      entryTime: fillTime,
      runningBest: order.price,
    };

    this.positionList.push(position);

    if (this.strategy.onOrderFill) {
      this.strategy.onOrderFill(
        {
          id: order.localOrderId,
          side: order.side,
          type: "limit",
          price: order.price,
          amount: order.amountUsd,
          fillTime,
          positionId: position.localPositionId,
          fillBarOpenTimestamp: args.fillBar?.openTimestamp,
          fillBarHigh: args.fillBar?.high,
          fillBarLow: args.fillBar?.low,
        },
        this,
      );
    }

    await this.sync();
  }

  async handleStopLossFilled(args: ProtectiveOrderFilledArgs): Promise<void> {
    this.ensureInitialized();

    const closedList = [...this.positionList];

    this.positionList = [];
    this.desiredStopLossPrice = null;
    this.desiredTakeProfitPrice = null;
    this.stopLossExchangeOrderId = null;
    this.lastSyncedStopLoss = null;

    for (const position of closedList) {
      if (this.strategy.onOrderFill) {
        this.strategy.onOrderFill(
          {
            id: `sl_${position.localPositionId}`,
            side: position.side === "long" ? "sell" : "buy",
            type: "stop",
            price: args.price,
            amount: position.amountUsd,
            fillTime: this.currentBar?.time ?? 0,
            positionId: position.localPositionId,
            entryPrice: position.entryPrice,
            runningBest: position.runningBest,
          },
          this,
        );
      }
    }

    await this.sync();
  }

  // An entry order disappeared on the exchange WITHOUT filling (cancelled externally / expired).
  // Removed from the local book so the desired-state sync does not re-place it; no strategy callback —
  // the strategy's own later cancel of the local id becomes a harmless no-op.
  handleEntryOrderCanceled(args: EntryOrderFilledArgs): void {
    this.entryOrderList = this.entryOrderList.filter((entry) => entry.exchangeOrderId !== args.exchangeOrderId);
  }

  // Mirror of the backtest runtime: a take-profit close does NOT call onOrderFill — the strategy
  // reconciles its position list on the next bar.
  async handleTakeProfitFilled(_args: ProtectiveOrderFilledArgs): Promise<void> {
    this.ensureInitialized();
    this.positionList = [];
    this.desiredStopLossPrice = null;
    this.desiredTakeProfitPrice = null;
    this.takeProfitExchangeOrderId = null;
    this.lastSyncedTakeProfit = null;
    await this.sync();
  }

  // The position disappeared outside the runner (manual close, liquidation). Clears the books and
  // syncs, which cancels any protective orders left on the exchange. The strategy notices the empty
  // position list on the next bar.
  async handleExternalPositionClose(): Promise<void> {
    this.ensureInitialized();
    this.positionList = [];
    this.desiredStopLossPrice = null;
    this.desiredTakeProfitPrice = null;
    await this.sync();
  }

  getSnapshot(): LiveRunnerSnapshot {
    return {
      strategySnapshot: this.strategy.getStateSnapshot?.() ?? null,
      barIndex: this.currentBarIndex,
      lastBarTime: this.currentBar?.time ?? null,
      entryOrderList: this.entryOrderList.map((entry) => ({ ...entry })),
      positionList: this.positionList.map((position) => ({ ...position })),
      desiredStopLossPrice: this.desiredStopLossPrice,
      desiredTakeProfitPrice: this.desiredTakeProfitPrice,
      stopLossExchangeOrderId: this.stopLossExchangeOrderId,
      takeProfitExchangeOrderId: this.takeProfitExchangeOrderId,
      lastSyncedStopLoss: this.lastSyncedStopLoss ? { ...this.lastSyncedStopLoss } : null,
      lastSyncedTakeProfit: this.lastSyncedTakeProfit ? { ...this.lastSyncedTakeProfit } : null,
      nextLocalOrderNumber: this.nextLocalOrderNumber,
      nextLocalPositionNumber: this.nextLocalPositionNumber,
      barHistory: this.barHistory.map((entry) => ({ ...entry })),
      oiHistory: this.oiHistory.map((entry) => (entry ? { ...entry } : null)),
      currentBar: this.currentBar ? { ...this.currentBar } : null,
      currentMaValues: this.currentMaValues ? { ...this.currentMaValues } : null,
      currentOiBar: this.currentOiBar ? { ...this.currentOiBar } : null,
    };
  }

  restoreSnapshot(snapshot: LiveRunnerSnapshot): void {
    this.ensureInitialized();
    this.currentBarIndex = snapshot.barIndex;
    this.entryOrderList = snapshot.entryOrderList.map((entry) => ({ ...entry }));
    this.positionList = snapshot.positionList.map((position) => ({ ...position }));
    this.desiredStopLossPrice = snapshot.desiredStopLossPrice;
    this.desiredTakeProfitPrice = snapshot.desiredTakeProfitPrice;
    this.stopLossExchangeOrderId = snapshot.stopLossExchangeOrderId;
    this.takeProfitExchangeOrderId = snapshot.takeProfitExchangeOrderId;
    this.lastSyncedStopLoss = snapshot.lastSyncedStopLoss ? { ...snapshot.lastSyncedStopLoss } : null;
    this.lastSyncedTakeProfit = snapshot.lastSyncedTakeProfit ? { ...snapshot.lastSyncedTakeProfit } : null;
    this.nextLocalOrderNumber = snapshot.nextLocalOrderNumber;
    this.nextLocalPositionNumber = snapshot.nextLocalPositionNumber;

    // Bar context is optional for backward-compat: a snapshot from an older SDK omits these fields,
    // and we then leave the rolling context empty (the host warms it up via catchUpBar, as before).
    if (snapshot.barHistory !== undefined) {
      this.barHistory = snapshot.barHistory.map((entry) => ({ ...entry }));
    }

    if (snapshot.oiHistory !== undefined) {
      this.oiHistory = snapshot.oiHistory.map((entry) => (entry ? { ...entry } : null));
    }

    if (snapshot.currentBar !== undefined) {
      this.currentBar = snapshot.currentBar ? { ...snapshot.currentBar } : null;
    }

    if (snapshot.currentMaValues !== undefined) {
      this.currentMaValues = snapshot.currentMaValues ? { ...snapshot.currentMaValues } : null;
    }

    if (snapshot.currentOiBar !== undefined) {
      this.currentOiBar = snapshot.currentOiBar ? { ...snapshot.currentOiBar } : null;
    }

    if (snapshot.strategySnapshot && this.strategy.restoreStateSnapshot) {
      this.strategy.restoreStateSnapshot(snapshot.strategySnapshot);
    }
  }

  getEntryOrderStateList(): LiveEntryOrderState[] {
    return this.entryOrderList.map((entry) => ({ ...entry }));
  }

  getPositionStateList(): LivePositionState[] {
    return this.positionList.map((position) => ({ ...position }));
  }

  getStopLossExchangeOrderId(): string | null {
    return this.stopLossExchangeOrderId;
  }

  getTakeProfitExchangeOrderId(): string | null {
    return this.takeProfitExchangeOrderId;
  }

  // ---------------------------------------------------------------------- TradingEnv

  // Market entries require the port to implement openPositionMarket; the desired entry is recorded
  // here and executed in sync(). If the port does not implement openPositionMarket we throw
  // immediately (via requireMarketEntrySupport) so the host learns about the misconfiguration
  // instead of silently dropping the entry. Strategies that use placeLimitOrder never touch this path.
  openLong(size: number, _options?: PositionOptions): void {
    this.requireMarketEntrySupport();
    this.desiredMarketEntry = { side: "buy", amountUsd: size };
  }

  openShort(size: number, _options?: PositionOptions): void {
    this.requireMarketEntrySupport();
    this.desiredMarketEntry = { side: "sell", amountUsd: size };
  }

  closeLong(): void {
    const position = this.positionList.find((entry) => entry.side === "long");

    if (position) this.closePosition(position.localPositionId);
  }

  closeShort(): void {
    const position = this.positionList.find((entry) => entry.side === "short");

    if (position) this.closePosition(position.localPositionId);
  }

  placeLimitOrder(side: "buy" | "sell", price: number, amount: number): string {
    const localOrderId = `lo_${this.nextLocalOrderNumber++}`;

    this.entryOrderList.push({
      localOrderId,
      side,
      price,
      amountUsd: amount,
      exchangeOrderId: null,
      createdAtBar: this.currentBarIndex,
    });

    return localOrderId;
  }

  cancelOrder(orderId: string): boolean {
    const order = this.entryOrderList.find((entry) => entry.localOrderId === orderId);

    if (!order) return false;

    if (order.exchangeOrderId !== null) {
      this.cancelRequestList.push({ localOrderId: order.localOrderId, exchangeOrderId: order.exchangeOrderId });
    }

    this.entryOrderList = this.entryOrderList.filter((entry) => entry.localOrderId !== orderId);

    return true;
  }

  cancelAllOrders(): void {
    for (const order of [...this.entryOrderList]) {
      this.cancelOrder(order.localOrderId);
    }
  }

  modifyOrderPrice(orderId: string, newPrice: number): boolean {
    const order = this.entryOrderList.find((entry) => entry.localOrderId === orderId);

    if (!order) return false;

    if (order.exchangeOrderId !== null) {
      this.cancelRequestList.push({ localOrderId: order.localOrderId, exchangeOrderId: order.exchangeOrderId });
      order.exchangeOrderId = null;
    }

    order.price = newPrice;

    return true;
  }

  getPendingOrderList(): PendingOrder[] {
    return this.entryOrderList.map((entry) => ({
      id: entry.localOrderId,
      side: entry.side,
      type: "limit" as const,
      price: entry.price,
      amount: entry.amountUsd,
      createdAtBar: entry.createdAtBar,
    }));
  }

  getPosition(positionId?: string): Position | null {
    if (positionId !== undefined) {
      const position = this.positionList.find((entry) => entry.localPositionId === positionId);

      return position ? this.toPositionView(position) : null;
    }

    const first = this.positionList[0];

    return first ? this.toPositionView(first) : null;
  }

  getPositionList(): Position[] {
    return this.positionList.map((position) => this.toPositionView(position));
  }

  closePosition(positionId?: string, _exitReason?: string): void {
    const target = positionId !== undefined
      ? this.positionList.find((entry) => entry.localPositionId === positionId)
      : this.positionList[0];

    if (!target) return;

    this.pendingCloseAmountUsd += target.amountUsd;
    this.pendingCloseContracts += target.contracts;
    this.positionList = this.positionList.filter((entry) => entry.localPositionId !== target.localPositionId);

    if (this.positionList.length === 0) {
      this.desiredStopLossPrice = null;
      this.desiredTakeProfitPrice = null;
    }
  }

  closeAllPositions(exitReason?: string): void {
    for (const position of [...this.positionList]) {
      this.closePosition(position.localPositionId, exitReason);
    }
  }

  setStopLoss(positionIdOrPrice: string | number, price?: number): void {
    if (typeof positionIdOrPrice === "number") {
      const first = this.positionList[0];

      if (first) {
        first.stopLoss = positionIdOrPrice;
        this.desiredStopLossPrice = positionIdOrPrice;
      }

      return;
    }

    const position = this.positionList.find((entry) => entry.localPositionId === positionIdOrPrice);

    if (position && price !== undefined) {
      position.stopLoss = price;
      this.desiredStopLossPrice = price;
    }
  }

  setTakeProfit(positionId: string, price: number): void {
    const position = this.positionList.find((entry) => entry.localPositionId === positionId);

    if (position) {
      position.takeProfit = price;
      this.desiredTakeProfitPrice = price;
    }
  }

  setPositionTag(positionId: string, tag: string): void {
    const position = this.positionList.find((entry) => entry.localPositionId === positionId);

    if (position) position.tag = tag;
  }

  setPositionDisplay(_positionId: string, _data: Record<string, unknown>): void {}

  getBalance(): number {
    return this.balanceProvider?.() ?? 0;
  }

  getBarIndex(): number {
    return this.currentBarIndex;
  }

  getCurrentBar(): Bar {
    if (!this.currentBar) throw new Error("No current bar");

    return this.currentBar;
  }

  getHistory(count: number, resolution?: string): Bar[] {
    if (resolution !== undefined) return [];

    return this.barHistory.slice(-count);
  }

  getOiClose(_resolution?: string): number | null {
    return this.currentOiBar?.close ?? null;
  }

  getOiOhlc(_resolution?: string): OiOhlc | null {
    return this.currentOiBar;
  }

  getOiOhlcHistory(count: number, _resolution?: string): Array<OiOhlc | null> {
    return this.oiHistory.slice(-count);
  }

  getLiqLongUsd(_resolution?: string): number | null {
    return null;
  }

  getLiqShortUsd(_resolution?: string): number | null {
    return null;
  }

  getLongShortRatio(_resolution?: string): number | null {
    return null;
  }

  getCurrentFundingRate(): number | null {
    return null;
  }

  getRecentFundingRates(_count: number): number[] {
    return [];
  }

  getAuxHistory(series: AuxSeriesKind, count: number, _resolution?: string): Array<number | null> {
    if (series === "oi") {
      return this.oiHistory.slice(-count).map((bar) => bar?.close ?? null);
    }

    return [];
  }

  getMaValues(_resolution: string): MaValues {
    return this.currentMaValues ?? ZERO_MA;
  }

  getParam<T extends ParamValue = ParamValue>(key: string, defaultValue: T): T {
    const value = this.params[key];

    if (value === undefined) return defaultValue;

    return value as T;
  }

  getConfig(): Record<string, unknown> {
    return this.rawConfig;
  }

  emitEvent(type: string, data: Record<string, unknown>): void {
    const event: BacktestEvent = { type, time: this.currentBar?.time ?? 0, data };

    this.onEvent?.(event);
  }

  // ---------------------------------------------------------------------- internals

  private ensureInitialized(): void {
    if (this.isInitialized) return;

    this.isInitialized = true;
    this.strategy.init?.(this);
  }

  private toPositionView(position: LivePositionState): Position {
    const closePrice = this.currentBar?.close ?? position.entryPrice;
    const pnl = position.side === "long"
      ? position.amountUsd * (closePrice - position.entryPrice) / position.entryPrice
      : position.amountUsd * (position.entryPrice - closePrice) / position.entryPrice;

    return {
      id: position.localPositionId,
      side: position.side,
      entryPrice: position.entryPrice,
      size: position.amountUsd,
      entryTime: position.entryTime,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      tag: position.tag,
      pnl,
      runningBest: position.runningBest,
    };
  }

  private updateRunningBest(bar: Bar): void {
    for (const position of this.positionList) {
      if (position.side === "long") {
        if (bar.high > position.runningBest) position.runningBest = bar.high;
      } else if (bar.low < position.runningBest) {
        position.runningBest = bar.low;
      }
    }
  }

  private getTotalContracts(): number {
    return this.positionList.reduce((sum, position) => sum + position.contracts, 0);
  }

  private getTotalAmountUsd(): number {
    return this.positionList.reduce((sum, position) => sum + position.amountUsd, 0);
  }

  // Desired-state sync: cancels first, then entry placements, then market closes, then protective
  // orders — so the exchange never briefly holds both an outdated ladder and the new one.
  private async sync(): Promise<void> {
    if (this.isCatchUpActive) return;

    const cancelList = [...this.cancelRequestList];

    this.cancelRequestList = [];

    for (const cancelArgs of cancelList) {
      await this.port.cancelEntryOrder(cancelArgs);
    }

    for (const order of this.entryOrderList.filter((entry) => entry.exchangeOrderId === null)) {
      const exchangeOrderId = await this.port.placeEntryOrder({
        localOrderId: order.localOrderId,
        side: order.side,
        price: order.price,
        amountUsd: order.amountUsd,
      });

      if (exchangeOrderId === null) {
        this.entryOrderList = this.entryOrderList.filter((entry) => entry.localOrderId !== order.localOrderId);
        this.emitEvent("entry_order_rejected", { localOrderId: order.localOrderId, price: order.price });
      } else {
        order.exchangeOrderId = exchangeOrderId;
      }
    }

    if (this.desiredMarketEntry !== null) {
      const entry = this.desiredMarketEntry;

      this.desiredMarketEntry = null;
      await this.executeMarketEntry(entry);
    }

    if (this.pendingCloseContracts > 0) {
      const closeArgs = { amountUsd: this.pendingCloseAmountUsd, contracts: this.pendingCloseContracts };

      this.pendingCloseAmountUsd = 0;
      this.pendingCloseContracts = 0;

      const closeResult = await this.port.closePositionMarket(closeArgs);

      if (closeResult !== null) {
        this.emitEvent(MARKET_CLOSE_FILLED_EVENT, { price: closeResult.exitPrice, time: this.currentBar?.time ?? 0 });
      }
    }

    await this.syncProtectiveOrders();
  }

  private requireMarketEntrySupport(): void {
    if (!this.port.openPositionMarket) {
      throw new Error(
        "Market entry (openLong/openShort) requires LiveExecutionPort.openPositionMarket, which this host did not implement. Use placeLimitOrder, or implement openPositionMarket on the port.",
      );
    }
  }

  private async executeMarketEntry(entry: { side: "buy" | "sell"; amountUsd: number }): Promise<void> {
    if (!this.port.openPositionMarket) {
      // Unreachable in normal flow: openLong/openShort already guard via requireMarketEntrySupport.
      // Kept as a defensive guard and for type-narrowing the optional port method.
      throw new Error("LiveExecutionPort.openPositionMarket is not implemented");
    }

    const result = await this.port.openPositionMarket(entry);

    if (result === null) {
      this.emitEvent("market_entry_rejected", { side: entry.side, amountUsd: entry.amountUsd });

      return;
    }

    const position: LivePositionState = {
      localPositionId: `pos_${this.nextLocalPositionNumber++}`,
      side: entry.side === "buy" ? "long" : "short",
      entryPrice: result.entryPrice,
      amountUsd: entry.amountUsd,
      contracts: entry.amountUsd / result.entryPrice,
      entryTime: this.currentBar?.time ?? 0,
      runningBest: result.entryPrice,
    };

    this.positionList.push(position);

    if (this.strategy.onOrderFill) {
      this.strategy.onOrderFill(
        {
          id: `me_${position.localPositionId}`,
          side: entry.side,
          type: "market",
          price: result.entryPrice,
          amount: entry.amountUsd,
          fillTime: this.currentBar?.time ?? 0,
          positionId: position.localPositionId,
        },
        this,
      );
    }

    this.emitEvent(MARKET_ENTRY_FILLED_EVENT, {
      side: entry.side,
      price: result.entryPrice,
      amountUsd: entry.amountUsd,
      time: position.entryTime,
    });
  }

  private async syncProtectiveOrders(): Promise<void> {
    const hasPositions = this.positionList.length > 0;
    const desiredStopLoss = hasPositions && this.desiredStopLossPrice !== null
      ? { price: this.desiredStopLossPrice, contracts: this.getTotalContracts() }
      : null;
    const desiredTakeProfit = hasPositions && this.desiredTakeProfitPrice !== null
      ? { price: this.desiredTakeProfitPrice, contracts: this.getTotalContracts() }
      : null;

    if (!desiredStopLoss && this.stopLossExchangeOrderId !== null) {
      const orderId = this.stopLossExchangeOrderId;

      this.stopLossExchangeOrderId = null;
      this.lastSyncedStopLoss = null;
      await this.port.cancelStopLoss({ exchangeOrderId: orderId });
    } else if (desiredStopLoss && !this.isProtectiveOrderSynced(this.lastSyncedStopLoss, desiredStopLoss)) {
      const newOrderId = await this.port.replaceStopLoss({
        previousExchangeOrderId: this.stopLossExchangeOrderId,
        price: desiredStopLoss.price,
        amountUsd: this.getTotalAmountUsd(),
        contracts: desiredStopLoss.contracts,
      });

      if (newOrderId !== null) {
        this.stopLossExchangeOrderId = newOrderId;
        this.lastSyncedStopLoss = desiredStopLoss;
      }
    }

    if (!desiredTakeProfit && this.takeProfitExchangeOrderId !== null) {
      const orderId = this.takeProfitExchangeOrderId;

      this.takeProfitExchangeOrderId = null;
      this.lastSyncedTakeProfit = null;
      await this.port.cancelTakeProfit({ exchangeOrderId: orderId });
    } else if (desiredTakeProfit && !this.isProtectiveOrderSynced(this.lastSyncedTakeProfit, desiredTakeProfit)) {
      const newOrderId = await this.port.replaceTakeProfit({
        previousExchangeOrderId: this.takeProfitExchangeOrderId,
        price: desiredTakeProfit.price,
        amountUsd: this.getTotalAmountUsd(),
        contracts: desiredTakeProfit.contracts,
      });

      if (newOrderId !== null) {
        this.takeProfitExchangeOrderId = newOrderId;
        this.lastSyncedTakeProfit = desiredTakeProfit;
      }
    }
  }

  private isProtectiveOrderSynced(synced: ProtectiveOrderSyncState | null, desired: ProtectiveOrderSyncState): boolean {
    return synced !== null && synced.price === desired.price && synced.contracts === desired.contracts;
  }
}
