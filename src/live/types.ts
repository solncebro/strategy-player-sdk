import type { BacktestEvent, Bar, MaValues, OiOhlc, ParamValue } from "../types";

export type LiveOrderSide = "buy" | "sell";

export interface PlaceEntryOrderArgs {
  localOrderId: string;
  side: LiveOrderSide;
  price: number;
  amountUsd: number;
}

export interface CancelEntryOrderArgs {
  localOrderId: string;
  exchangeOrderId: string;
}

export interface ReplaceProtectiveOrderArgs {
  previousExchangeOrderId: string | null;
  price: number;
  amountUsd: number;
  contracts: number;
}

export interface CancelProtectiveOrderArgs {
  exchangeOrderId: string;
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
  placeEntryOrder(args: PlaceEntryOrderArgs): Promise<string | null>;
  cancelEntryOrder(args: CancelEntryOrderArgs): Promise<boolean>;
  /**
   * Open a position at market (optional — only needed by strategies that use
   * `openLong/openShort` in live). Returns the exchange order id and the average
   * fill price, or null on rejection.
   */
  openPositionMarket?(args: OpenPositionMarketArgs): Promise<OpenPositionMarketResult | null>;
  replaceStopLoss(args: ReplaceProtectiveOrderArgs): Promise<string | null>;
  cancelStopLoss(args: CancelProtectiveOrderArgs): Promise<boolean>;
  replaceTakeProfit(args: ReplaceProtectiveOrderArgs): Promise<string | null>;
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
}

export interface LiveRunnerSnapshot {
  strategySnapshot: Record<string, unknown> | null;
  barIndex: number;
  lastBarTime: number | null;
  entryOrderList: LiveEntryOrderState[];
  positionList: LivePositionState[];
  desiredStopLossPrice: number | null;
  desiredTakeProfitPrice: number | null;
  stopLossExchangeOrderId: string | null;
  takeProfitExchangeOrderId: string | null;
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
}

export interface ProtectiveOrderFilledArgs {
  price: number;
}
