import type {
  AuxSeriesKind,
  BacktestEvent,
  Bar,
  MaValues,
  OiOhlc,
  OiProvider,
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
/** A reduced entry landing spawns a shortfall order placed in the SAME sync; this bounds the passes
 *  so an exchange that keeps reducing cannot loop forever (leftovers retry on the next sync). */
const MAX_ENTRY_PLACEMENT_PASS_COUNT = 3;

/** One closed bar plus everything the host knows about it at that moment. */
interface AdvanceBarArgs {
  bar: Bar;
  maValues?: MaValues;
  oiBar?: OiOhlc;
  volume24hUsd?: number;
}

/**
 * Drives ONE strategy instance (= one symbol+direction) against a live exchange through a
 * LiveExecutionPort. The strategy sees the exact same TradingEnv contract as in the backtest player;
 * the runner translates its synchronous calls into a desired order/position state and syncs that
 * state to the exchange after every bar / fill handler ("desired-state sync").
 *
 * Aggregation: the strategy holds N small positions (one per limit fill, mirroring the backtest
 * runtime), while the exchange holds ONE netted position. Protective orders (stop-loss /
 * take-profit) therefore sync as ONE logical order covering the total size — physically a SET of
 * exchange orders when the size exceeds the per-order cap (the port owns the splitting; the runner
 * tracks the piece id list). The strategy is expected to keep one uniform protective price across
 * its positions (the last set price wins, same for the optional exit-reason code).
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
  private readonly oiProvider: OiProvider | null;

  private barHistory: Bar[] = [];
  private currentBar: Bar | null = null;
  private currentMaValues: MaValues | null = null;
  private currentBarIndex = -1;
  private oiHistory: Array<OiOhlc | null> = [];
  private currentOiBar: OiOhlc | null = null;
  /** 24h quote volume of the current bar, supplied per bar by the host (the exchange feed knows it). */
  private currentVolume24hUsd: number | null = null;
  private desiredMarketEntry: { side: "buy" | "sell"; amountUsd: number } | null = null;

  private entryOrderList: LiveEntryOrderState[] = [];
  private cancelRequestList: CancelEntryOrderArgs[] = [];
  private positionList: LivePositionState[] = [];
  private desiredStopLossPrice: number | null = null;
  private desiredTakeProfitPrice: number | null = null;
  private desiredStopLossReason: string | null = null;
  private desiredTakeProfitReason: string | null = null;
  private stopLossExchangeOrderIdList: string[] = [];
  private takeProfitExchangeOrderIdList: string[] = [];
  private lastSyncedStopLoss: ProtectiveOrderSyncState | null = null;
  private lastSyncedTakeProfit: ProtectiveOrderSyncState | null = null;
  private isProtectiveSyncHeld = false;
  private pendingCloseAmountUsd = 0;
  private pendingCloseContracts = 0;
  private nextLocalOrderNumber = 1;
  private nextLocalPositionNumber = 1;
  private isCatchUpActive = false;
  private isInitialized = false;
  private isSyncRunning = false;
  private isSyncRerunRequested = false;

  constructor(strategy: Strategy, options: LiveStrategyRunnerOptions) {
    this.strategy = strategy;
    this.port = options.port;
    this.params = options.params ?? strategy.params;
    this.rawConfig = options.rawConfig ?? {};
    this.onEvent = options.onEvent;
    this.balanceProvider = options.getBalanceUsd;
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.oiProvider = options.oiProvider ?? null;
  }

  // ---------------------------------------------------------------------- runner API

  async feedClosedBar(bar: Bar, maValues?: MaValues, oiBar?: OiOhlc, volume24hUsd?: number): Promise<void> {
    this.ensureInitialized();

    // A bar already incorporated (time <= the last one) is skipped — no strategy run, no sync — so a
    // host that replays missed/already-seen klines after a snapshot restore does not double-process.
    if (!this.advanceBar({ bar, maValues, oiBar, volume24hUsd })) return;

    this.strategy.onBar(bar, maValues ?? ZERO_MA, this);
    await this.sync();
  }

  // Replay a historical closed bar to build price/open-interest history WITHOUT running the strategy
  // and WITHOUT touching the exchange — live warmup, so a fresh start does not act on signals that
  // closed before going live. Idempotent by bar time (see advanceBar): replaying a bar already in the
  // restored history is a no-op, so restore + catch-up compose without doubling history.
  catchUpBar(bar: Bar, maValues?: MaValues, oiBar?: OiOhlc, volume24hUsd?: number): void {
    this.ensureInitialized();
    this.advanceBar({ bar, maValues, oiBar, volume24hUsd });
  }

  // Advance the rolling market context by one closed bar: push the previous bar/OI into history
  // (trimmed to historyLimit), then set the new current bar/MA/OI and update running-best. Returns
  // false (and does nothing) when the bar is at or before the last incorporated bar — the idempotency
  // guard that lets snapshot-restore and catch-up compose without doubling history or drifting the
  // bar index. Shared by feedClosedBar and catchUpBar so the two paths cannot diverge.
  private advanceBar(args: AdvanceBarArgs): boolean {
    const { bar, maValues, oiBar, volume24hUsd } = args;

    if (this.currentBar && bar.time <= this.currentBar.time) return false;

    if (this.currentBar) {
      this.barHistory.push(this.currentBar);

      if (this.oiProvider === null) this.oiHistory.push(this.currentOiBar);

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
    this.currentOiBar = this.oiProvider === null ? (oiBar ?? null) : null;
    this.currentVolume24hUsd = volume24hUsd ?? null;
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

    // A partial fill the engine crystallized supplies the real filled notional; a full fill (and all
    // backtest/paper fills, which consume the whole order) omits it, so the order's amountUsd stands.
    const filledAmountUsd = args.filledAmountUsd ?? order.amountUsd;
    // The exchange's real average fill price wins over the limit target — a resting limit can fill
    // better than its price, and the book must mirror the exchange (see EntryOrderFilledArgs).
    const fillPrice = args.avgFillPrice ?? order.price;

    const position: LivePositionState = {
      localPositionId: `pos_${this.nextLocalPositionNumber++}`,
      side: order.side === "buy" ? "long" : "short",
      entryPrice: fillPrice,
      amountUsd: filledAmountUsd,
      contracts: filledAmountUsd / fillPrice,
      entryTime: fillTime,
      runningBest: fillPrice,
    };

    this.positionList.push(position);

    if (this.strategy.onOrderFill) {
      this.strategy.onOrderFill(
        {
          id: order.localOrderId,
          side: order.side,
          type: "limit",
          price: fillPrice,
          amountUsd: filledAmountUsd,
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

  /** The host must call this only when the protective exit is COMPLETE — every stop piece is
   *  terminal and the exchange position is confirmed flat. The whole book clears; the price is the
   *  volume-weighted average across the pieces. */
  async handleStopLossFilled(args: ProtectiveOrderFilledArgs): Promise<void> {
    this.ensureInitialized();

    const closedList = [...this.positionList];

    this.positionList = [];
    this.desiredStopLossPrice = null;
    this.desiredTakeProfitPrice = null;
    this.desiredStopLossReason = null;
    this.desiredTakeProfitReason = null;
    this.stopLossExchangeOrderIdList = [];
    this.lastSyncedStopLoss = null;
    // The trade is over — the ladder tail must not survive it (leftover rungs would re-open a
    // position out of nowhere). Cancelled in the same sync below, not on the next bar.
    this.cancelAllOrders();

    for (const position of closedList) {
      if (this.strategy.onOrderFill) {
        this.strategy.onOrderFill(
          {
            id: `sl_${position.localPositionId}`,
            side: position.side === "long" ? "sell" : "buy",
            type: "stop",
            price: args.price,
            amountUsd: position.amountUsd,
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
  // reconciles its position list on the next bar. The host must call this only when the protective
  // exit is COMPLETE — every take-profit piece is terminal and the exchange position is confirmed flat.
  async handleTakeProfitFilled(_args: ProtectiveOrderFilledArgs): Promise<void> {
    this.ensureInitialized();
    this.positionList = [];
    this.desiredStopLossPrice = null;
    this.desiredTakeProfitPrice = null;
    this.desiredStopLossReason = null;
    this.desiredTakeProfitReason = null;
    this.takeProfitExchangeOrderIdList = [];
    this.lastSyncedTakeProfit = null;
    this.cancelAllOrders();
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
    this.desiredStopLossReason = null;
    this.desiredTakeProfitReason = null;
    this.cancelAllOrders();
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
      desiredStopLossReason: this.desiredStopLossReason,
      desiredTakeProfitReason: this.desiredTakeProfitReason,
      stopLossExchangeOrderIdList: [...this.stopLossExchangeOrderIdList],
      takeProfitExchangeOrderIdList: [...this.takeProfitExchangeOrderIdList],
      lastSyncedStopLoss: this.lastSyncedStopLoss ? { ...this.lastSyncedStopLoss } : null,
      lastSyncedTakeProfit: this.lastSyncedTakeProfit ? { ...this.lastSyncedTakeProfit } : null,
      nextLocalOrderNumber: this.nextLocalOrderNumber,
      nextLocalPositionNumber: this.nextLocalPositionNumber,
      barHistory: this.barHistory.map((entry) => ({ ...entry })),
      currentBar: this.currentBar ? { ...this.currentBar } : null,
      currentMaValues: this.currentMaValues ? { ...this.currentMaValues } : null,
      // With an oiProvider the runner owns no OI series — omit both so a restore never seeds one.
      ...(this.oiProvider === null
        ? {
            oiHistory: this.oiHistory.map((entry) => (entry ? { ...entry } : null)),
            currentOiBar: this.currentOiBar ? { ...this.currentOiBar } : null,
          }
        : {}),
    };
  }

  restoreSnapshot(snapshot: LiveRunnerSnapshot): void {
    this.ensureInitialized();
    this.currentBarIndex = snapshot.barIndex;
    this.entryOrderList = snapshot.entryOrderList.map((entry) => ({ ...entry }));
    this.positionList = snapshot.positionList.map((position) => ({ ...position }));
    this.desiredStopLossPrice = snapshot.desiredStopLossPrice;
    this.desiredTakeProfitPrice = snapshot.desiredTakeProfitPrice;
    this.desiredStopLossReason = snapshot.desiredStopLossReason ?? null;
    this.desiredTakeProfitReason = snapshot.desiredTakeProfitReason ?? null;

    // Pre-2.0 snapshots carried a single protective order id — restored as a one-element list.
    this.stopLossExchangeOrderIdList = snapshot.stopLossExchangeOrderIdList
      ?? (snapshot.stopLossExchangeOrderId ? [snapshot.stopLossExchangeOrderId] : []);
    this.takeProfitExchangeOrderIdList = snapshot.takeProfitExchangeOrderIdList
      ?? (snapshot.takeProfitExchangeOrderId ? [snapshot.takeProfitExchangeOrderId] : []);

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

  getStopLossExchangeOrderIdList(): string[] {
    return [...this.stopLossExchangeOrderIdList];
  }

  getTakeProfitExchangeOrderIdList(): string[] {
    return [...this.takeProfitExchangeOrderIdList];
  }

  getDesiredStopLossReason(): string | null {
    return this.desiredStopLossReason;
  }

  getDesiredTakeProfitReason(): string | null {
    return this.desiredTakeProfitReason;
  }

  /** Drop the synced markers so the next sync re-places both protective order sets at the current
   *  desired values — the host's escape hatch when it detects the exchange lost part of the set. */
  invalidateProtectiveSync(): void {
    this.lastSyncedStopLoss = null;
    this.lastSyncedTakeProfit = null;
  }

  /** Invalidate AND re-sync the protective sets right away. The host's coverage watchdog uses this
   *  so a detected deficit heals on the watchdog cadence (seconds) instead of waiting for the next
   *  bar to trigger a sync — an unprotected remainder must live as briefly as possible. */
  async resyncProtectiveOrders(): Promise<void> {
    this.ensureInitialized();
    this.invalidateProtectiveSync();
    await this.sync();
  }

  /** While held, protective REPLACE placements are frozen (a protective exit is being finalized —
   *  re-placing mid-exit would fight the fills). Cancels still run: finalizing a stop must still be
   *  able to cancel the orphaned take-profit set, and vice versa. */
  setProtectiveSyncHold(isHeld: boolean): void {
    this.isProtectiveSyncHeld = isHeld;
  }

  // ---------------------------------------------------------------------- TradingEnv

  // Market entries require the port to implement openPositionMarket; the desired entry is recorded
  // here and executed in sync(). If the port does not implement openPositionMarket we throw
  // immediately (via requireMarketEntrySupport) so the host learns about the misconfiguration
  // instead of silently dropping the entry. Strategies that use placeLimitOrder never touch this path.
  openLong(sizeUsd: number, _options?: PositionOptions): void {
    this.requireMarketEntrySupport();
    this.desiredMarketEntry = { side: "buy", amountUsd: sizeUsd };
  }

  openShort(sizeUsd: number, _options?: PositionOptions): void {
    this.requireMarketEntrySupport();
    this.desiredMarketEntry = { side: "sell", amountUsd: sizeUsd };
  }

  closeLong(): void {
    const position = this.positionList.find((entry) => entry.side === "long");

    if (position) this.closePosition(position.localPositionId);
  }

  closeShort(): void {
    const position = this.positionList.find((entry) => entry.side === "short");

    if (position) this.closePosition(position.localPositionId);
  }

  // One logical strategy order books as ONE entry per cap piece (the port owns the split): every
  // piece then fills, expires and cancels through the ordinary book lifecycle, and a notional over
  // the exchange's per-order cap can never be silently reduced. Returns the FIRST piece's local id;
  // strategies that store it for a targeted cancel/modify only reach the first piece — rubber's
  // strategy cancels by iterating getPendingOrderList, which reaches them all.
  placeLimitOrder(side: "buy" | "sell", price: number, amountUsd: number): string {
    const pieceNotionalList = this.port.splitEntryNotionalUsd?.({ price, amountUsd }) ?? [amountUsd];
    const bookNotionalList = pieceNotionalList.length > 0 ? pieceNotionalList : [amountUsd];
    let firstLocalOrderId = "";

    for (const pieceNotional of bookNotionalList) {
      const localOrderId = `lo_${this.nextLocalOrderNumber++}`;

      if (firstLocalOrderId === "") firstLocalOrderId = localOrderId;

      this.entryOrderList.push({
        localOrderId,
        side,
        price,
        amountUsd: pieceNotional,
        exchangeOrderId: null,
        createdAtBar: this.currentBarIndex,
      });
    }

    return firstLocalOrderId;
  }

  cancelOrder(orderId: string): boolean {
    const order = this.entryOrderList.find((entry) => entry.localOrderId === orderId);

    if (!order) return false;

    // Never placed on the exchange yet — nothing to confirm, drop it locally right away.
    if (order.exchangeOrderId === null) {
      this.entryOrderList = this.entryOrderList.filter((entry) => entry.localOrderId !== orderId);

      return true;
    }

    // Placed: only MARK it. The order leaves the book when the exchange confirms the cancel in
    // sync() — a cancel lost to a transient failure keeps the order tracked (its fill still routes,
    // the reconciliation poll still sees it) and sync retries the cancel every cycle.
    order.isCancelRequested = true;

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
      amountUsd: entry.amountUsd,
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
      this.desiredStopLossReason = null;
      this.desiredTakeProfitReason = null;
      this.cancelAllOrders();
    }
  }

  closeAllPositions(exitReason?: string): void {
    for (const position of [...this.positionList]) {
      this.closePosition(position.localPositionId, exitReason);
    }
  }

  setStopLoss(positionIdOrPrice: string | number, price?: number, reason?: string): void {
    if (typeof positionIdOrPrice === "number") {
      const first = this.positionList[0];

      if (first) {
        first.stopLoss = positionIdOrPrice;
        this.desiredStopLossPrice = positionIdOrPrice;
        this.desiredStopLossReason = reason ?? null;
      }

      return;
    }

    const position = this.positionList.find((entry) => entry.localPositionId === positionIdOrPrice);

    if (position && price !== undefined) {
      position.stopLoss = price;
      this.desiredStopLossPrice = price;
      this.desiredStopLossReason = reason ?? null;
    }
  }

  setTakeProfit(positionId: string, price: number, reason?: string): void {
    const position = this.positionList.find((entry) => entry.localPositionId === positionId);

    if (position) {
      position.takeProfit = price;
      this.desiredTakeProfitPrice = price;
      this.desiredTakeProfitReason = reason ?? null;
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
    return this.getOiOhlc()?.close ?? null;
  }

  /** 24h quote volume of the current bar, as handed in by the host (see feedClosedBar). Null when the
   *  host does not supply it — a strategy that gates on liquidity must then decide what that means. */
  getVolume24h(_resolution?: string): number | null {
    return this.currentVolume24hUsd;
  }

  getOiOhlc(_resolution?: string): OiOhlc | null {
    if (this.oiProvider !== null) return this.currentBar ? this.oiProvider(this.currentBar.time) : null;

    return this.currentOiBar;
  }

  // With a provider the series resolves by the price bars' times at call time — index-aligned with
  // the legacy frozen series (barHistory never contains the current bar), but late OI becomes visible.
  getOiOhlcHistory(count: number, _resolution?: string): Array<OiOhlc | null> {
    if (this.oiProvider !== null) return this.barHistory.slice(-count).map((bar) => this.oiProvider!(bar.time));

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
      return this.getOiOhlcHistory(count).map((bar) => bar?.close ?? null);
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
      sizeUsd: position.amountUsd,
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

  // Serialisation lock: a sync requested while one is already running (an exchange fill event lands
  // mid-placement) must NEVER run concurrently — two passes would both see not-yet-placed orders and
  // place them twice (the SOXLUSDT doubled-ladder incident). The re-entrant request only marks a
  // rerun; the lock owner repeats the pass until no rerun is pending, so mid-sync state changes are
  // still materialised. A flag (not a promise chain) so a re-entrant caller returns immediately and
  // cannot deadlock the pass it interrupted.
  private async sync(): Promise<void> {
    if (this.isSyncRunning) {
      this.isSyncRerunRequested = true;

      return;
    }

    this.isSyncRunning = true;

    try {
      do {
        this.isSyncRerunRequested = false;
        await this.executeSync();
      } while (this.isSyncRerunRequested);
    } finally {
      this.isSyncRunning = false;
    }
  }

  // Desired-state sync: cancels first, then entry placements, then market closes, then protective
  // orders — so the exchange never briefly holds both an outdated ladder and the new one.
  private async executeSync(): Promise<void> {
    if (this.isCatchUpActive) return;

    // Requested cancels: the order leaves the book ONLY when the port confirms the exchange
    // accepted the cancellation. A failed cancel keeps the order tracked and retries next sync.
    for (const order of this.entryOrderList.filter((entry) => entry.isCancelRequested && entry.exchangeOrderId !== null)) {
      const isCancelled = await this.port.cancelEntryOrder({ localOrderId: order.localOrderId, exchangeOrderId: order.exchangeOrderId as string });

      if (isCancelled) {
        this.entryOrderList = this.entryOrderList.filter((entry) => entry.localOrderId !== order.localOrderId);
      }
    }

    // Modify-price replacements still use the fire-and-forget queue (the order stays in the book
    // with exchangeOrderId reset, so it is re-placed below either way).
    const cancelList = [...this.cancelRequestList];

    this.cancelRequestList = [];

    for (const cancelArgs of cancelList) {
      await this.port.cancelEntryOrder(cancelArgs);
    }

    // Multi-pass placement: a reduced landing shrinks the booked order to what the exchange really
    // accepted and pushes the shortfall as a fresh order, placed by the NEXT pass of this same sync
    // — the intended notional reaches the exchange immediately, never waiting for another bar.
    for (let placementPass = 0; placementPass < MAX_ENTRY_PLACEMENT_PASS_COUNT; placementPass++) {
      const unplacedList = this.entryOrderList.filter((entry) => entry.exchangeOrderId === null);

      if (unplacedList.length === 0) break;

      for (const order of unplacedList) {
        const result = await this.port.placeEntryOrder({
          localOrderId: order.localOrderId,
          side: order.side,
          price: order.price,
          amountUsd: order.amountUsd,
        });

        if (result === null) {
          this.entryOrderList = this.entryOrderList.filter((entry) => entry.localOrderId !== order.localOrderId);
          this.emitEvent("entry_order_rejected", { localOrderId: order.localOrderId, price: order.price });
          continue;
        }

        order.exchangeOrderId = result.exchangeOrderId;

        const acceptedAmountUsd = result.acceptedAmountUsd;

        if (acceptedAmountUsd === undefined || acceptedAmountUsd >= order.amountUsd) continue;

        const shortfallAmountUsd = order.amountUsd - acceptedAmountUsd;

        order.amountUsd = acceptedAmountUsd;
        this.entryOrderList.push({
          localOrderId: `lo_${this.nextLocalOrderNumber++}`,
          side: order.side,
          price: order.price,
          amountUsd: shortfallAmountUsd,
          exchangeOrderId: null,
          createdAtBar: order.createdAtBar,
        });
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
          amountUsd: entry.amountUsd,
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

  // Each protective side syncs its SET of exchange orders (several pieces when the quantity exceeds
  // the per-order cap — the port owns the splitting). Cancel branches always run; replace branches
  // are frozen while the host holds the sync (a protective exit is being finalized). An incomplete
  // replace keeps lastSynced null, so the next sync cancels the stored partial set and re-places.
  private async syncProtectiveOrders(): Promise<void> {
    const hasPositions = this.positionList.length > 0;
    const desiredStopLoss = hasPositions && this.desiredStopLossPrice !== null
      ? { price: this.desiredStopLossPrice, contracts: this.getTotalContracts() }
      : null;
    const desiredTakeProfit = hasPositions && this.desiredTakeProfitPrice !== null
      ? { price: this.desiredTakeProfitPrice, contracts: this.getTotalContracts() }
      : null;

    if (!desiredStopLoss && this.stopLossExchangeOrderIdList.length > 0) {
      const orderIdList = this.stopLossExchangeOrderIdList;

      this.stopLossExchangeOrderIdList = [];
      this.lastSyncedStopLoss = null;
      await this.port.cancelStopLoss({ exchangeOrderIdList: orderIdList });
    } else if (desiredStopLoss && !this.isProtectiveSyncHeld && !this.isProtectiveOrderSynced(this.lastSyncedStopLoss, desiredStopLoss)) {
      const result = await this.port.replaceStopLoss({
        previousExchangeOrderIdList: this.stopLossExchangeOrderIdList,
        price: desiredStopLoss.price,
        amountUsd: this.getTotalAmountUsd(),
        contracts: desiredStopLoss.contracts,
        reason: this.desiredStopLossReason,
      });

      if (result !== null) {
        this.stopLossExchangeOrderIdList = result.exchangeOrderIdList;
        this.lastSyncedStopLoss = result.isComplete ? desiredStopLoss : null;
      }
    }

    if (!desiredTakeProfit && this.takeProfitExchangeOrderIdList.length > 0) {
      const orderIdList = this.takeProfitExchangeOrderIdList;

      this.takeProfitExchangeOrderIdList = [];
      this.lastSyncedTakeProfit = null;
      await this.port.cancelTakeProfit({ exchangeOrderIdList: orderIdList });
    } else if (desiredTakeProfit && !this.isProtectiveSyncHeld && !this.isProtectiveOrderSynced(this.lastSyncedTakeProfit, desiredTakeProfit)) {
      const result = await this.port.replaceTakeProfit({
        previousExchangeOrderIdList: this.takeProfitExchangeOrderIdList,
        price: desiredTakeProfit.price,
        amountUsd: this.getTotalAmountUsd(),
        contracts: desiredTakeProfit.contracts,
      });

      if (result !== null) {
        this.takeProfitExchangeOrderIdList = result.exchangeOrderIdList;
        this.lastSyncedTakeProfit = result.isComplete ? desiredTakeProfit : null;
      }
    }
  }

  private isProtectiveOrderSynced(synced: ProtectiveOrderSyncState | null, desired: ProtectiveOrderSyncState): boolean {
    return synced !== null && synced.price === desired.price && synced.contracts === desired.contracts;
  }
}
