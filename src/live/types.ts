import type { BacktestEvent, Bar, MaValues, OiOhlc, OiProvider, ParamValue } from "../types";

export type LiveOrderSide = "buy" | "sell";

export interface PlaceEntryOrderArgs {
  localOrderId: string;
  side: LiveOrderSide;
  price: number;
  amountUsd: number;
}

export interface PlaceEntryOrderResult {
  exchangeOrderId: string;
  /** Set when the exchange accepted the order SMALLER than requested: the notional actually resting
   *  on the exchange. The runner then shrinks the booked order to this value and immediately places
   *  the shortfall as a fresh order — a reduced-but-working order is never cancelled, the missing
   *  part is topped up instead (the position must fill as fast as possible). */
  acceptedAmountUsd?: number;
}

export interface SplitEntryNotionalArgs {
  price: number;
  amountUsd: number;
}

export interface CancelEntryOrderArgs {
  localOrderId: string;
  exchangeOrderId: string;
}

export interface ReplaceProtectiveOrderArgs {
  /** Every piece currently believed live on the exchange — the port cancels them before placing. */
  previousExchangeOrderIdList: string[];
  price: number;
  amountUsd: number;
  contracts: number;
  // The strategy's reason tag behind this protective level (e.g. "stop_loss_emergency|15"). Lets
  // the port recognise entry-anchored levels and re-derive them from the exchange's own average
  // entry instead of trusting the book's price alone (the book can lag real fills).
  reason?: string | null;
}

export interface ReplaceProtectiveOrderResult {
  /** Every piece believed LIVE after the operation: freshly placed pieces PLUS any previous pieces
   *  whose cancel failed (still resting on the exchange — their fills must keep routing). */
  exchangeOrderIdList: string[];
  /** True only when every previous piece was cancelled AND the full desired quantity was placed.
   *  False keeps the runner unsynced, so the next sync retries with this id list. */
  isComplete: boolean;
}

export interface CancelProtectiveOrderArgs {
  exchangeOrderIdList: string[];
}

export interface ClosePositionMarketArgs {
  amountUsd: number;
  contracts: number;
}

export interface ClosePositionMarketResult {
  exitPrice: number;
}

export interface OpenPositionMarketArgs {
  side: LiveOrderSide;
  amountUsd: number;
}

export interface OpenPositionMarketResult {
  exchangeOrderId: string;
  entryPrice: number;
}

/** Emitted by the runner after a market entry/close confirms its real average fill price. */
export const MARKET_ENTRY_FILLED_EVENT = "market_entry_filled";
export const MARKET_CLOSE_FILLED_EVENT = "market_close_filled";

/**
 * The narrow contract a trading bot implements on top of its own order infrastructure so the
 * LiveStrategyRunner can execute a strategy's decisions for ONE symbol+direction. Every method is
 * business-meaning only — no exchange flags. Methods return the exchange order id (or null on
 * rejection, which the runner treats as "retry on the next sync").
 */
export interface LiveExecutionPort {
  /** Place one entry order. Returns null when the order did not land (rejected / vanished after an
   *  OK answer) — the runner drops it; a result with `acceptedAmountUsd` reports a reduced landing
   *  (see PlaceEntryOrderResult). */
  placeEntryOrder(args: PlaceEntryOrderArgs): Promise<PlaceEntryOrderResult | null>;
  /**
   * Split an entry notional into per-order pieces, each independently placeable under the
   * exchange's per-order quantity cap (an oversized order gets SILENTLY reduced by the exchange).
   * The runner books one entry order per piece, so every piece fills, expires and cancels through
   * the ordinary lifecycle. Optional: a port without caps omits it; an empty result falls back to
   * the unsplit notional (the placement path then reports the refusal through its normal channel).
   */
  splitEntryNotionalUsd?(args: SplitEntryNotionalArgs): number[];
  cancelEntryOrder(args: CancelEntryOrderArgs): Promise<boolean>;
  /**
   * Open a position at market (optional — only needed by strategies that use
   * `openLong/openShort` in live). Returns the exchange order id and the average
   * fill price, or null on rejection.
   */
  openPositionMarket?(args: OpenPositionMarketArgs): Promise<OpenPositionMarketResult | null>;
  /**
   * Replace the protective order set: cancel every id in previousExchangeOrderIdList, then place
   * the desired quantity — split into several exchange orders when it exceeds the per-order cap.
   * Returns the live piece ids and whether the replacement fully succeeded; null means nothing
   * changed (the runner retries on the next sync with the same previous set).
   */
  replaceStopLoss(args: ReplaceProtectiveOrderArgs): Promise<ReplaceProtectiveOrderResult | null>;
  cancelStopLoss(args: CancelProtectiveOrderArgs): Promise<boolean>;
  replaceTakeProfit(args: ReplaceProtectiveOrderArgs): Promise<ReplaceProtectiveOrderResult | null>;
  cancelTakeProfit(args: CancelProtectiveOrderArgs): Promise<boolean>;
  closePositionMarket(args: ClosePositionMarketArgs): Promise<ClosePositionMarketResult | null>;
}

export interface LiveEntryOrderState {
  localOrderId: string;
  side: LiveOrderSide;
  price: number;
  amountUsd: number;
  exchangeOrderId: string | null;
  createdAtBar: number;
  /** Set when the strategy asked to cancel this placed order. The order stays in the book until the
   *  exchange CONFIRMS the cancellation (sync retries every cycle) — a cancel lost to a transient
   *  failure never orphans a live exchange order, and a fill racing the cancel is still routed. */
  isCancelRequested?: boolean;
}

export interface LivePositionState {
  localPositionId: string;
  side: "long" | "short";
  entryPrice: number;
  amountUsd: number;
  contracts: number;
  entryTime: number;
  stopLoss?: number;
  takeProfit?: number;
  tag?: string;
  runningBest: number;
}

export interface ProtectiveOrderSyncState {
  price: number;
  contracts: number;
}

export interface LiveStrategyRunnerOptions {
  port: LiveExecutionPort;
  params?: Record<string, ParamValue>;
  rawConfig?: Record<string, unknown>;
  onEvent?: (event: BacktestEvent) => void;
  getBalanceUsd?: () => number;
  historyLimit?: number;
  /** Live read-through OI source; when set, the runner neither accumulates nor reads its own OI series. */
  oiProvider?: OiProvider;
}

export interface LiveRunnerSnapshot {
  strategySnapshot: Record<string, unknown> | null;
  barIndex: number;
  lastBarTime: number | null;
  entryOrderList: LiveEntryOrderState[];
  positionList: LivePositionState[];
  desiredStopLossPrice: number | null;
  desiredTakeProfitPrice: number | null;
  /** Machine exit-reason code the strategy attached to the stop level (see TradingEnv.setStopLoss). */
  desiredStopLossReason?: string | null;
  desiredTakeProfitReason?: string | null;
  /** Optional for backward-compat: pre-2.0 snapshots carry the scalar id fields below instead. */
  stopLossExchangeOrderIdList?: string[];
  takeProfitExchangeOrderIdList?: string[];
  /** @deprecated Pre-2.0 snapshots carried a single protective order id; restored as a one-element list. */
  stopLossExchangeOrderId?: string | null;
  /** @deprecated Pre-2.0 snapshots carried a single protective order id; restored as a one-element list. */
  takeProfitExchangeOrderId?: string | null;
  lastSyncedStopLoss: ProtectiveOrderSyncState | null;
  lastSyncedTakeProfit: ProtectiveOrderSyncState | null;
  nextLocalOrderNumber: number;
  nextLocalPositionNumber: number;
  /**
   * Rolling market context so a restored runner can serve getHistory/getCurrentBar/getMaValues/OI
   * immediately, without the host first replaying warm-up bars. Optional for backward-compat: a
   * snapshot persisted by an older SDK omits these, and restoreSnapshot then leaves the context empty
   * (the host must warm it up via catchUpBar, as before). Bounded by the runner's historyLimit.
   */
  barHistory?: Bar[];
  oiHistory?: Array<OiOhlc | null>;
  currentBar?: Bar | null;
  currentMaValues?: MaValues | null;
  currentOiBar?: OiOhlc | null;
}

export interface EntryOrderFilledArgs {
  exchangeOrderId: string;
  // The forming bar during which the order physically filled (the live engine reads it from the live
  // kline mirror). When provided it overrides the runner's last-CLOSED-bar currentBar for the fill's
  // bar attribution (entryTime / FilledOrder.fillTime + fillBar* fields) — fixing the off-by-one for
  // strategies that snapshot the entry candle. Omit in backtest/paper (fills are already intra-bar).
  fillBar?: { openTimestamp: number; high: number; low: number };
  // The USD notional ACTUALLY filled, when it differs from the order's full amountUsd (a partial fill
  // the live engine crystallized by cancelling the remainder). When provided, the booked position is
  // sized from it instead of the order's full amountUsd. Omit in backtest/paper and for full fills —
  // fills there always consume the whole order, so the order's amountUsd is correct.
  filledAmountUsd?: number;
  // The exchange's volume-weighted average fill price. A resting limit can fill BETTER than its
  // limit price (the market ran past the level before the order landed) — the book must carry the
  // real entry, not the target, or every average-entry-derived level (stops, takes, journal) drifts
  // (ESPORTSUSDT 19.07: rung booked at 0.026412, real fill 0.02712). Omit in backtest/paper, where
  // fills happen exactly at the limit price.
  avgFillPrice?: number;
}

export interface ProtectiveOrderFilledArgs {
  price: number;
}
