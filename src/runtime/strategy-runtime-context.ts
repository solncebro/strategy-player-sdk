import type {
  AuxSeriesData,
  AuxSeriesKind,
  BacktestContextOptions,
  BacktestContextResult,
  BacktestEvent,
  Bar,
  CommissionConfig,
  EquityPoint,
  FilledOrder,
  FundingRate,
  MaValues,
  ParamValue,
  PendingOrder,
  Position,
  PositionOptions,
  Strategy,
  TimeframeData,
  Trade,
  TradingEnv,
} from "../types";
import { barDurationMs } from "./timeframe";

interface ClosePositionByIdArgs {
  positionId: string;
  exitPrice: number;
  exitReason: string;
  commissionType: "maker" | "taker" | null;
}

interface TimeframeStore {
  resolution: string;
  barList: Bar[];
  auxSeriesData: AuxSeriesData;
  durationMs: number;
  currentIndex: number;
  auxHistoryByKind: Record<AuxSeriesKind, Array<number | null>>;
  maCacheIndex: number;
  maCacheValue: MaValues | null;
}

const EMPTY_AUX_SERIES: AuxSeriesData = {
  oiByTime: new Map(),
  liqLongByTime: new Map(),
  liqShortByTime: new Map(),
  lsrByTime: new Map(),
};

const AUX_KIND_LIST: AuxSeriesKind[] = ["oi", "liqLong", "liqShort", "lsr"];

const ZERO_MA_VALUES: MaValues = {
  ma25: 0,
  ma50: 0,
  ma100: 0,
  ma200: 0,
  ma99: null,
  ma1000: null,
};

function createTimeframeStore(data: TimeframeData): TimeframeStore {
  const barList = [...data.barList].sort((a, b) => a.time - b.time);

  return {
    resolution: data.resolution,
    barList,
    auxSeriesData: data.auxSeriesData ?? EMPTY_AUX_SERIES,
    durationMs: barDurationMs(data.resolution),
    currentIndex: -1,
    auxHistoryByKind: { oi: [], liqLong: [], liqShort: [], lsr: [] },
    maCacheIndex: -2,
    maCacheValue: null,
  };
}

function getAuxMapFor(data: AuxSeriesData, kind: AuxSeriesKind): Map<number, number> {
  if (kind === "oi") return data.oiByTime;
  if (kind === "liqLong") return data.liqLongByTime;
  if (kind === "liqShort") return data.liqShortByTime;
  return data.lsrByTime;
}

const MA_PERIOD_LIST = [
  { period: 25, key: "ma25" as const },
  { period: 50, key: "ma50" as const },
  { period: 100, key: "ma100" as const },
  { period: 200, key: "ma200" as const },
];

function computeMaValuesFromClosedBars(barList: Bar[], currentIndex: number): MaValues {
  const result: MaValues = {
    ma25: 0,
    ma50: 0,
    ma100: 0,
    ma200: 0,
    ma99: null,
    ma1000: null,
  };

  for (const { period, key } of MA_PERIOD_LIST) {
    if (currentIndex + 1 < period) continue;

    let sum = 0;
    const startInclusive = currentIndex - period + 1;

    for (let i = startInclusive; i <= currentIndex; i++) {
      sum += barList[i].close;
    }

    result[key] = sum / period;
  }

  return result;
}

const ZERO_COMMISSION: CommissionConfig = {
  makerRate: 0,
  takerRate: 0,
};

export class StrategyRuntimeContext implements TradingEnv {
  private positionById = new Map<string, Position>();
  private nextPositionId = 1;
  private commissionByPositionId = new Map<string, number>();
  private displayByPositionId = new Map<string, Record<string, unknown>>();
  private fundingByPositionId = new Map<string, number>();

  private balance: number;
  private tradeList: Trade[] = [];
  private equityList: EquityPoint[] = [];
  private barHistory: Bar[] = [];
  private currentBarIndex = -1;
  private currentBar: Bar | null = null;

  private pendingOrderList: PendingOrder[] = [];
  private nextOrderId = 1;
  private readonly commission: CommissionConfig;
  private totalCommission = 0;
  private totalFunding = 0;

  private readonly fundingRateList: FundingRate[];
  private fundingIndex = 0;
  private readonly applyFundingCost: boolean;

  private readonly params: Record<string, ParamValue>;
  private readonly rawConfig: Record<string, unknown>;
  private strategy: Strategy | null = null;
  private eventList: BacktestEvent[] = [];

  private readonly auxSeriesData: AuxSeriesData;
  private readonly auxHistoryByKind: Record<AuxSeriesKind, Array<number | null>> = {
    oi: [],
    liqLong: [],
    liqShort: [],
    lsr: [],
  };

  private readonly timeframeStoreByRes = new Map<string, TimeframeStore>();

  private readonly maValuesByResolution = new Map<
    string,
    Map<number, MaValues>
  >();
  private readonly volume24hByResolution = new Map<string, Map<number, number>>();
  private mainResolution: string | null = null;

  constructor(initialBalance: number, options?: BacktestContextOptions) {
    this.balance = initialBalance;
    this.commission = options?.commission ?? ZERO_COMMISSION;
    this.fundingRateList = options?.fundingRateList ?? [];
    this.applyFundingCost = options?.applyFundingCost ?? true;
    this.params = options?.params ?? {};
    this.rawConfig = options?.rawConfig ?? {};
    this.auxSeriesData = options?.auxSeriesData ?? EMPTY_AUX_SERIES;

    for (const data of options?.timeframeDataList ?? []) {
      this.timeframeStoreByRes.set(data.resolution, createTimeframeStore(data));
    }
  }

  setStrategy(strategy: Strategy): void {
    this.strategy = strategy;
  }

  setMainResolution(resolution: string): void {
    this.mainResolution = resolution;
  }

  setMaValuesForResolution(
    resolution: string,
    mapByTime: Map<number, MaValues>,
  ): void {
    this.maValuesByResolution.set(resolution, mapByTime);
  }

  setVolume24hForResolution(
    resolution: string,
    mapByTime: Map<number, number>,
  ): void {
    this.volume24hByResolution.set(resolution, mapByTime);
  }

  getVolume24h(resolution?: string): number | null {
    const res = resolution ?? this.mainResolution;

    if (!res) return null;

    const map = this.volume24hByResolution.get(res);

    if (!map) return null;

    if (res === this.mainResolution) {
      if (!this.currentBar) return null;

      return map.get(this.currentBar.time) ?? null;
    }

    const store = this.timeframeStoreByRes.get(res);

    if (!store || store.currentIndex < 0) return null;

    const bar = store.barList[store.currentIndex];

    if (!bar) return null;

    return map.get(bar.time) ?? null;
  }

  openLong(size: number, options?: PositionOptions): void {
    this.openPositionAtMarket("long", size, options);
  }

  openShort(size: number, options?: PositionOptions): void {
    this.openPositionAtMarket("short", size, options);
  }

  closeLong(): void {
    this.closeBySignal("long");
  }

  closeShort(): void {
    this.closeBySignal("short");
  }

  placeLimitOrder(side: "buy" | "sell", price: number, amount: number): string {
    const id = `order_${this.nextOrderId++}`;
    this.pendingOrderList.push({
      id,
      side,
      type: "limit",
      price,
      amount,
      createdAtBar: this.currentBarIndex,
    });
    return id;
  }

  cancelOrder(orderId: string): boolean {
    const index = this.pendingOrderList.findIndex((o) => o.id === orderId);
    if (index === -1) return false;
    this.pendingOrderList.splice(index, 1);
    return true;
  }

  cancelAllOrders(): void {
    this.pendingOrderList = [];
  }

  modifyOrderPrice(orderId: string, newPrice: number): boolean {
    const order = this.pendingOrderList.find((o) => o.id === orderId);
    if (!order) return false;
    order.price = newPrice;
    return true;
  }

  getPendingOrderList(): PendingOrder[] {
    return [...this.pendingOrderList];
  }

  getPosition(positionId?: string): Position | null {
    if (positionId) {
      return this.getPositionById(positionId);
    }

    const first = this.positionById.values().next().value;
    if (!first || !this.currentBar) return null;
    return { ...first, pnl: this.calcPnl(first, this.currentBar.close) };
  }

  getPositionList(): Position[] {
    if (!this.currentBar) return [];

    return Array.from(this.positionById.values()).map((pos) => ({
      ...pos,
      pnl: this.calcPnl(pos, this.currentBar!.close),
    }));
  }

  closePosition(positionId?: string, exitReason?: string): void {
    if (!this.currentBar) return;

    const reason = exitReason ?? "close";

    if (positionId) {
      this.closePositionById({ positionId, exitPrice: this.currentBar.close, exitReason: reason, commissionType: "taker" });
    } else {
      const first = this.positionById.values().next().value;

      if (first) this.closePositionById({ positionId: first.id, exitPrice: this.currentBar.close, exitReason: reason, commissionType: "taker" });
    }
  }

  closeAllPositions(exitReason?: string): void {
    if (!this.currentBar) return;

    const reason = exitReason ?? "close";

    for (const pos of [...this.positionById.values()]) {
      this.closePositionById({ positionId: pos.id, exitPrice: this.currentBar.close, exitReason: reason, commissionType: "taker" });
    }
  }

  setStopLoss(positionIdOrPrice: string | number, price?: number): void {
    if (typeof positionIdOrPrice === "number") {
      const first = this.positionById.values().next().value;

      if (first) first.stopLoss = positionIdOrPrice;
    } else {
      const pos = this.positionById.get(positionIdOrPrice);
      if (pos && price !== undefined) pos.stopLoss = price;
    }
  }

  getBalance(): number {
    return this.balance;
  }

  getBarIndex(): number {
    return this.currentBarIndex;
  }

  getCurrentBar(): Bar {
    if (!this.currentBar) throw new Error("No current bar");
    return this.currentBar;
  }

  getHistory(count: number, resolution?: string): Bar[] {
    if (resolution === undefined) {
      return this.barHistory.slice(-count);
    }

    const store = this.requireTimeframeStore(resolution);

    if (store.currentIndex < 0 || count <= 0) return [];

    const endExclusive = store.currentIndex + 1;
    const startInclusive = Math.max(0, endExclusive - count);

    return store.barList.slice(startInclusive, endExclusive);
  }

  getOiClose(resolution?: string): number | null {
    return this.lookupAuxForResolution("oi", resolution);
  }

  getLiqLongUsd(resolution?: string): number | null {
    return this.lookupAuxForResolution("liqLong", resolution);
  }

  getLiqShortUsd(resolution?: string): number | null {
    return this.lookupAuxForResolution("liqShort", resolution);
  }

  getLongShortRatio(resolution?: string): number | null {
    return this.lookupAuxForResolution("lsr", resolution);
  }

  getCurrentFundingRate(): number | null {
    if (!this.currentBar || this.fundingRateList.length === 0) return null;
    const t = this.currentBar.time;
    let lo = 0;
    let hi = this.fundingRateList.length - 1;
    let bestIdx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.fundingRateList[mid].time <= t) {
        bestIdx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return bestIdx >= 0 ? this.fundingRateList[bestIdx].rate : null;
  }

  getRecentFundingRates(count: number): number[] {
    if (!this.currentBar || count <= 0) return [];
    const t = this.currentBar.time;
    let endIdx = -1;
    let lo = 0;
    let hi = this.fundingRateList.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.fundingRateList[mid].time <= t) {
        endIdx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (endIdx < 0) return [];
    const startIdx = Math.max(0, endIdx - count + 1);
    return this.fundingRateList.slice(startIdx, endIdx + 1).map((f) => f.rate);
  }

  getAuxHistory(series: AuxSeriesKind, count: number, resolution?: string): Array<number | null> {
    if (resolution === undefined) {
      return this.auxHistoryByKind[series].slice(-count);
    }

    const store = this.requireTimeframeStore(resolution);

    return store.auxHistoryByKind[series].slice(-count);
  }

  getMaValues(resolution: string): MaValues {
    const injectedMap = this.maValuesByResolution.get(resolution);

    if (injectedMap) {
      if (resolution === this.mainResolution) {
        if (!this.currentBar) return { ...ZERO_MA_VALUES };

        const injected = injectedMap.get(this.currentBar.time);

        if (injected) return injected;
      } else {
        const store = this.timeframeStoreByRes.get(resolution);

        if (store && store.currentIndex >= 0) {
          const bar = store.barList[store.currentIndex];

          if (bar) {
            const injected = injectedMap.get(bar.time);

            if (injected) return injected;
          }
        }
      }
    }

    const store = this.timeframeStoreByRes.get(resolution);

    if (!store || store.currentIndex < 0) {
      return { ...ZERO_MA_VALUES };
    }

    if (store.maCacheIndex === store.currentIndex && store.maCacheValue) {
      return store.maCacheValue;
    }

    const computed = computeMaValuesFromClosedBars(store.barList, store.currentIndex);
    store.maCacheIndex = store.currentIndex;
    store.maCacheValue = computed;

    return computed;
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
    if (!this.currentBar) return;

    this.eventList.push({ type, time: this.currentBar.time, data });
  }

  setPositionTag(positionId: string, tag: string): void {
    const position = this.positionById.get(positionId);

    if (position) position.tag = tag;
  }

  setPositionDisplay(positionId: string, data: Record<string, unknown>): void {
    this.displayByPositionId.set(positionId, data);
  }

  processBar(bar: Bar, maValues?: MaValues): void {
    if (this.currentBar) {
      this.barHistory.push(this.currentBar);
      this.pushAuxHistoryFor(this.currentBar.time);
    }
    this.currentBarIndex++;
    this.currentBar = bar;

    this.advanceTimeframeStores(bar.time);

    if (this.positionById.size > 0) {
      this.updateRunningBest(bar);
      this.checkStopLoss(bar);
    }

    this.checkPendingOrders(bar, maValues);
    this.applyFunding(bar);

    this.equityList.push({
      barIndex: this.currentBarIndex,
      timestamp: bar.time,
      balance: this.getEffectiveBalance(),
    });
  }

  private advanceTimeframeStores(mainBarTime: number): void {
    for (const store of this.timeframeStoreByRes.values()) {
      while (
        store.currentIndex + 1 < store.barList.length &&
        store.barList[store.currentIndex + 1].time + store.durationMs <= mainBarTime
      ) {
        store.currentIndex++;
        store.maCacheIndex = -2;
        store.maCacheValue = null;

        const bar = store.barList[store.currentIndex];

        for (const kind of AUX_KIND_LIST) {
          const value = getAuxMapFor(store.auxSeriesData, kind).get(bar.time);
          store.auxHistoryByKind[kind].push(value === undefined ? null : value);
        }
      }
    }
  }

  forceCloseAll(): void {
    this.pendingOrderList = [];

    if (!this.currentBar || this.positionById.size === 0) return;

    for (const pos of [...this.positionById.values()]) {
      this.closePositionById({ positionId: pos.id, exitPrice: this.currentBar.close, exitReason: "end_of_data", commissionType: "taker" });
    }
  }

  getResult(): BacktestContextResult {
    return { tradeList: this.tradeList, equityList: this.equityList, eventList: this.eventList };
  }

  private updateRunningBest(bar: Bar): void {
    for (const position of this.positionById.values()) {
      if (position.side === "long") {
        if (bar.high > position.runningBest) position.runningBest = bar.high;
      } else {
        if (bar.low < position.runningBest) position.runningBest = bar.low;
      }
    }
  }

  private getAuxMapByKind(kind: AuxSeriesKind): Map<number, number> {
    if (kind === "oi") return this.auxSeriesData.oiByTime;
    if (kind === "liqLong") return this.auxSeriesData.liqLongByTime;
    if (kind === "liqShort") return this.auxSeriesData.liqShortByTime;
    return this.auxSeriesData.lsrByTime;
  }

  private lookupAuxOnCurrentBar(kind: AuxSeriesKind): number | null {
    if (!this.currentBar) return null;

    const value = this.getAuxMapByKind(kind).get(this.currentBar.time);

    return value === undefined ? null : value;
  }

  private lookupAuxForResolution(kind: AuxSeriesKind, resolution?: string): number | null {
    if (resolution === undefined) {
      return this.lookupAuxOnCurrentBar(kind);
    }

    const store = this.requireTimeframeStore(resolution);

    if (store.currentIndex < 0) return null;

    const bar = store.barList[store.currentIndex];
    const value = getAuxMapFor(store.auxSeriesData, kind).get(bar.time);

    return value === undefined ? null : value;
  }

  private requireTimeframeStore(resolution: string): TimeframeStore {
    const store = this.timeframeStoreByRes.get(resolution);

    if (!store) {
      throw new Error(
        `Timeframe "${resolution}" is not loaded. Declare it in Strategy.requiredTimeframes.`,
      );
    }

    return store;
  }

  private pushAuxHistoryFor(timeMs: number): void {
    for (const kind of AUX_KIND_LIST) {
      const value = this.getAuxMapByKind(kind).get(timeMs);
      this.auxHistoryByKind[kind].push(value === undefined ? null : value);
    }
  }

  private getPositionById(positionId: string): Position | null {
    const pos = this.positionById.get(positionId);

    if (!pos || !this.currentBar) return null;

    return { ...pos, pnl: this.calcPnl(pos, this.currentBar.close) };
  }

  private checkStopLoss(bar: Bar): void {
    for (const position of [...this.positionById.values()]) {
      if (position.side === "long") {
        if (position.stopLoss !== undefined && bar.low <= position.stopLoss) {
          const entryPrice = position.entryPrice;
          const runningBest = position.runningBest;
          this.closePositionById({ positionId: position.id, exitPrice: position.stopLoss, exitReason: "stop_loss", commissionType: "taker" });

          if (this.strategy?.onOrderFill) {
            this.strategy.onOrderFill(
              {
                id: `sl_${position.id}`,
                side: "sell",
                type: "stop",
                price: position.stopLoss,
                amount: position.size,
                fillTime: bar.time,
                positionId: position.id,
                entryPrice,
                runningBest,
              },
              this,
            );
          }
          continue;
        }

        if (position.takeProfit !== undefined && bar.high >= position.takeProfit) {
          this.closePositionById({ positionId: position.id, exitPrice: position.takeProfit, exitReason: "take_profit", commissionType: "taker" });
          continue;
        }
      } else {
        if (position.stopLoss !== undefined && bar.high >= position.stopLoss) {
          const entryPrice = position.entryPrice;
          const runningBest = position.runningBest;
          this.closePositionById({ positionId: position.id, exitPrice: position.stopLoss, exitReason: "stop_loss", commissionType: "taker" });

          if (this.strategy?.onOrderFill) {
            this.strategy.onOrderFill(
              {
                id: `sl_${position.id}`,
                side: "buy",
                type: "stop",
                price: position.stopLoss,
                amount: position.size,
                fillTime: bar.time,
                positionId: position.id,
                entryPrice,
                runningBest,
              },
              this,
            );
          }
          continue;
        }

        if (position.takeProfit !== undefined && bar.low <= position.takeProfit) {
          this.closePositionById({ positionId: position.id, exitPrice: position.takeProfit, exitReason: "take_profit", commissionType: "taker" });
          continue;
        }
      }
    }
  }

  private checkPendingOrders(bar: Bar, maValues?: MaValues): void {
    if (this.strategy?.onBeforeLimitFill && maValues) {
      const limitOrderList = this.pendingOrderList.filter((o) => o.type === "limit");

      for (const _ of limitOrderList) {
        const allowed = this.strategy.onBeforeLimitFill(maValues, this);

        if (!allowed) break;
        break;
      }
    }

    const filledIndexList: number[] = [];

    for (let i = 0; i < this.pendingOrderList.length; i++) {
      const order = this.pendingOrderList[i];

      if (order.type === "stop") {
        const triggered =
          order.side === "sell"
            ? bar.low <= order.price
            : bar.high >= order.price;

        if (triggered) {
          filledIndexList.push(i);
          this.fillOrder(order, bar);
        }
      } else {
        const triggered =
          order.side === "buy"
            ? bar.low <= order.price
            : bar.high >= order.price;

        if (triggered) {
          filledIndexList.push(i);
          this.fillOrder(order, bar);
        }
      }
    }

    for (let i = filledIndexList.length - 1; i >= 0; i--) {
      this.pendingOrderList.splice(filledIndexList[i], 1);
    }
  }

  private fillOrder(order: PendingOrder, bar: Bar): void {
    const fillPrice = order.price;
    const commissionRate = order.type === "limit" ? this.commission.makerRate : this.commission.takerRate;
    const fillCommission = order.amount * commissionRate;
    this.totalCommission += fillCommission;
    this.balance -= fillCommission;

    const positionId = `pos_${this.nextPositionId++}`;
    const side: "long" | "short" = order.side === "buy" ? "long" : "short";

    this.positionById.set(positionId, {
      id: positionId,
      side,
      entryPrice: fillPrice,
      size: order.amount,
      entryTime: bar.time,
      pnl: 0,
      runningBest: fillPrice,
    });

    this.commissionByPositionId.set(positionId, fillCommission);
    this.fundingByPositionId.set(positionId, 0);

    const filledOrder: FilledOrder = {
      id: order.id,
      side: order.side,
      type: order.type,
      price: fillPrice,
      amount: order.amount,
      fillTime: bar.time,
      positionId,
    };

    if (this.strategy?.onOrderFill) {
      this.strategy.onOrderFill(filledOrder, this);
    }
  }

  private applyFunding(bar: Bar): void {
    if (!this.applyFundingCost) return;
    if (this.positionById.size === 0 || this.fundingRateList.length === 0) return;

    while (
      this.fundingIndex < this.fundingRateList.length &&
      this.fundingRateList[this.fundingIndex].time <= bar.time
    ) {
      const fundingRate = this.fundingRateList[this.fundingIndex];

      for (const position of this.positionById.values()) {
        if (fundingRate.time >= position.entryTime) {
          const sign = position.side === "long" ? -1 : 1;
          const cost = position.size * fundingRate.rate * sign;
          this.balance += cost;
          const current = this.fundingByPositionId.get(position.id) ?? 0;
          this.fundingByPositionId.set(position.id, current + cost);
          this.totalFunding += cost;
        }
      }

      this.fundingIndex++;
    }
  }

  private openPositionAtMarket(side: "long" | "short", size: number, options?: PositionOptions): void {
    if (!this.currentBar) {
      throw new Error(`Cannot open ${side}: no current bar`);
    }

    const positionId = `pos_${this.nextPositionId++}`;
    const entryCommission = size * this.commission.takerRate;
    this.totalCommission += entryCommission;
    this.balance -= entryCommission;
    this.commissionByPositionId.set(positionId, entryCommission);
    this.fundingByPositionId.set(positionId, 0);

    this.positionById.set(positionId, {
      id: positionId,
      side,
      entryPrice: this.currentBar.close,
      size,
      entryTime: this.currentBar.time,
      stopLoss: options?.stopLoss,
      takeProfit: options?.takeProfit,
      tag: options?.tag,
      pnl: 0,
      runningBest: this.currentBar.close,
    });
  }

  private closeBySignal(side: "long" | "short"): void {
    if (!this.currentBar) {
      throw new Error(`Cannot close ${side}: no current bar`);
    }

    const position = [...this.positionById.values()].find((p) => p.side === side);

    if (!position) {
      throw new Error(`Cannot close ${side}: no ${side} position open`);
    }

    this.closePositionById({ positionId: position.id, exitPrice: this.currentBar.close, exitReason: "close", commissionType: "taker" });
  }

  private calcPnl(position: Position, exitPrice: number): number {
    return position.side === "long"
      ? position.size * (exitPrice - position.entryPrice) / position.entryPrice
      : position.size * (position.entryPrice - exitPrice) / position.entryPrice;
  }

  private closePositionById(args: ClosePositionByIdArgs): void {
    const { positionId, exitPrice, exitReason, commissionType } = args;
    const position = this.positionById.get(positionId);

    if (!position || !this.currentBar) return;

    let exitCommission = 0;

    if (commissionType) {
      const rate = commissionType === "maker" ? this.commission.makerRate : this.commission.takerRate;
      exitCommission = position.size * (exitPrice / position.entryPrice) * rate;
      this.totalCommission += exitCommission;
      this.balance -= exitCommission;
    }

    const entryCommission = this.commissionByPositionId.get(positionId) ?? 0;
    const totalPositionCommission = entryCommission + exitCommission;
    const positionFunding = this.fundingByPositionId.get(positionId) ?? 0;

    const pnl = this.calcPnl(position, exitPrice);
    const pnlPercent = (pnl / position.size) * 100;

    this.tradeList.push({
      positionId,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      size: position.size,
      pnl,
      pnlPercent,
      entryTime: position.entryTime,
      exitTime: this.currentBar.time,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      exitReason,
      tag: position.tag,
      commission: totalPositionCommission,
      funding: positionFunding,
      netPnl: pnl - totalPositionCommission + positionFunding,
      display: this.displayByPositionId.get(positionId),
    });

    this.balance += pnl;
    this.positionById.delete(positionId);
    this.commissionByPositionId.delete(positionId);
    this.fundingByPositionId.delete(positionId);
    this.displayByPositionId.delete(positionId);
  }

  private getEffectiveBalance(): number {
    if (this.positionById.size === 0 || !this.currentBar) return this.balance;

    let unrealizedPnl = 0;

    for (const pos of this.positionById.values()) {
      unrealizedPnl += this.calcPnl(pos, this.currentBar.close);
    }

    return this.balance + unrealizedPnl;
  }
}
