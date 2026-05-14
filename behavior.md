# strategy-player-sdk — Behavior Specification

> **Audience:** authors of trading strategies who write code against `strategy-player-sdk`.
> **Status:** Canonical. Pinned to `v1.0.0`. Additive evolution only — see CHANGELOG.md.
>
> Read this together with the TypeScript types in `src/types.ts` (or `dist/index.d.ts` after `yarn install`). Types alone tell you the **shape** of the API; this document tells you the **runtime semantics**.

---

## 1. What a strategy is

A strategy is a TypeScript module that **default-exports** an object implementing the [`Strategy`](./src/types.ts) interface (or returns one through the [`defineStrategy<TParams>(spec)`](./src/define-strategy.ts) helper). The runtime — `StrategyRuntimeContext` in this SDK, `LiveTradingEnv` in production trading bots — drives the strategy bar by bar, exposing market data and order primitives through the `TradingEnv` interface.

```typescript
import { defineStrategy } from "@solncebro/strategy-player-sdk";

export default defineStrategy({
  name: "My Strategy",
  version: "1.0",
  params: { fastPeriod: 9, slowPeriod: 21 },
  onBar(bar, maValues, env) {
    /* ... */
  },
});
```

The same module is consumed by the backtest engine (strategy-player) and by live trading bots (e.g. ma-bounce). **Identical code path runs in both environments.** Only the `TradingEnv` implementation differs.

---

## 2. Strategy contract

```typescript
interface Strategy {
  name: string;
  version: string;
  params: Record<string, ParamValue>;            // ParamValue = number | string | boolean

  init?(env: TradingEnv): void;                                            // before first bar
  onBar(bar: Bar, maValues: MaValues, env: TradingEnv): void;              // every bar
  onOrderFill?(order: FilledOrder, env: TradingEnv): void;                 // after pending or SL fill
  onBeforeLimitFill?(maValues: MaValues, env: TradingEnv): boolean;        // veto pending limits
  onEnd?(env: TradingEnv): void;                                            // after last bar
}
```

Required: `name`, `version`, `params`, `onBar`. Optional: `init`, `onOrderFill`, `onBeforeLimitFill`, `onEnd`.

The runtime validates these requirements when loading the strategy. Missing required fields cause the load to fail before the first bar is fed.

---

## 3. Lifecycle and bar pipeline

For each bar in chronological order, the runtime executes:

```
1. processBar(bar, maValues)         // internal — strategies don't call it
   1.1. push previous bar into barHistory + push aux values into auxHistory
   1.2. currentBarIndex++, currentBar = bar
   1.3. updateRunningBest()           // for every open position
   1.4. checkStopLoss(bar)            // SL/TP — see §4 Fill priority
   1.5. if pending limits exist:
        — call strategy.onBeforeLimitFill?(maValues, env) — strategy may cancel/replace
        — checkPendingOrders(bar) FIFO by createdAtBar
   1.6. applyFunding(bar)             // fund all open positions for any funding events ≤ bar.time
   1.7. equityList.push({ barIndex, timestamp, balance: effectiveBalance })

2. strategy.onBar(bar, maValues, env)
```

Once at the very start (before bar 0): `strategy.init?(env)`.
Once at the very end (after the last bar's `onBar`): `strategy.onEnd?(env)` → `forceCloseAll()`.

`forceCloseAll()` cancels pending orders and closes every still-open position at `currentBar.close` with `exitReason: "end_of_data"` and **taker commission**.

`strategy.onOrderFill?(filledOrder, env)` is called **synchronously** inside `processBar`:
- right after a pending limit/stop fill (within `checkPendingOrders`),
- or right after SL hits (within `checkStopLoss`) — with `entryPrice` and `runningBest` propagated on `FilledOrder` so the strategy can compute MFE-style metrics after the position is removed.

Strategies are guaranteed to see `onOrderFill` before the same bar's `onBar` — the fill happens during `processBar`, `onBar` runs after.

---

## 4. Fill priority inside processBar

Inside a single bar, multiple events may "fire". The runtime resolves them deterministically:

1. **Stop loss / take profit** — checked first against `bar.low` / `bar.high` (long: SL on `bar.low ≤ stopLoss`, TP on `bar.high ≥ takeProfit`; short: mirror). Worst-case-first: if both an SL and a counter-side limit could fill on the same bar, the SL closes the position. There is no "what really happened intra-bar" — the engine picks the conservative outcome.
2. **Pending orders** — limits and stops are processed in FIFO order by `createdAtBar` (the bar index when `placeLimitOrder`/`placeStopOrder` was called).
3. **Funding** — applied **after** all fills, against the still-open positions.

Within (2), each pending order is checked exactly once per bar:
- `limit buy` triggers when `bar.low ≤ price`,
- `limit sell` triggers when `bar.high ≥ price`,
- `stop sell` triggers when `bar.low ≤ price`,
- `stop buy` triggers when `bar.high ≥ price`.

Fill price is always `order.price`, not the bar OHLC. (Slippage isn't modeled in v1.0.)

---

## 5. Commission split — maker vs taker

`CommissionConfig = { makerRate, takerRate }`. Defaults at the player level: `makerRate = 0.0002` (0.02%), `takerRate = 0.0004` (0.04%).

| Operation | Rate |
|---|---|
| `openLong` / `openShort` (market entry) | taker |
| `closeLong` / `closeShort` / `closePosition` / `closeAllPositions` | taker |
| Stop loss / take profit fill | taker |
| Limit order fill via `placeLimitOrder` | maker |
| `forceCloseAll` (end-of-data closure) | taker |

Commission is applied **on both entry and exit**:
- Entry: `size * rate` (charged immediately in account currency, deducted from `balance`).
- Exit: `size * (exitPrice / entryPrice) * rate` (proportional to the closing notional).

Each `Trade` records its **total** commission (entry + exit) in `Trade.commission`. Net P&L per trade is:
```
netPnl = pnl - commission + funding
```

---

## 6. Funding model

Funding rates are 8-hour interval events on Binance Futures (00:00 / 08:00 / 16:00 UTC). The runtime applies them per-position:

```
fundingCost = position.size * fundingRate.rate * sign
sign = -1 for long, +1 for short
```

So **positive funding rate ⇒ longs pay, shorts receive**. Negative rate is the reverse.

A funding event at time `T` is applied on the first bar with `bar.time ≥ T`, and only against positions that were opened before the event (`fundingRate.time ≥ position.entryTime`). Funding is then accumulated into `Trade.funding` and `balance`.

If `useFunding` is `false` (or `fundingRateList` is empty), funding is a no-op.

Source of funding rates in the backtest engine: PostgreSQL `funding_research.funding`. In live: exchange WebSocket / REST.

---

## 7. Position MFE — `runningBest`

Every `Position` carries a `runningBest` field — the most favorable price seen since entry (Maximum Favorable Excursion). The runtime maintains it on every bar:

- For `long`: `runningBest = max(bar.high, prev runningBest)`. Initialized at `entryPrice`.
- For `short`: `runningBest = min(bar.low, prev runningBest)`. Initialized at `entryPrice`.

When a stop loss fires, the runtime propagates `entryPrice` and `runningBest` of the closed position into the `FilledOrder` passed to `onOrderFill?` (optional fields `FilledOrder.entryPrice`/`runningBest`). This lets strategies compute MFE-based metrics after the position is removed from the open list.

Strategies that don't care about MFE simply ignore these fields — they're optional in the type.

---

## 8. Sandbox limits

Strategies are bundled by `esbuild` (`format: "cjs"`, `platform: "neutral"`, `bundle: true`) and executed in a Node.js `vm` sandbox with a 5-second startup timeout.

**Available globals** (whitelist):
```
console, Math, Date, JSON, Array, Object, Number, String, Boolean,
Map, Set, Error, RegExp, parseInt, parseFloat, isNaN, isFinite,
Infinity, NaN, undefined
```

**Forbidden** (will throw or silently fail):
- `process`, `globalThis` access beyond the whitelist
- `require`, dynamic `import()` (after bundling there shouldn't be any)
- `fs`, `path`, `http`, `net`, `os` and all Node.js built-ins
- `fetch`, `XMLHttpRequest`, `WebSocket`
- `eval`, `Function` constructor

**npm dependencies are allowed** if they are pure-JS (no `Function`/`eval`, no Node.js APIs). esbuild inlines them into the strategy bundle — you `import { something } from "lodash"` and the function body ends up in your bundle. **You don't add lodash to the player; you add it to your strategy repo.**

The SDK itself satisfies these constraints: pure types + pure-TS runtime, no runtime deps.

---

## 9. Aux data nullability

The `TradingEnv` accessors for auxiliary series (`getOiClose`, `getLiqLongUsd`, `getLiqShortUsd`, `getLongShortRatio`, `getCurrentFundingRate`) return `null` when the underlying source has no record at the current `bar.time`. **Strategies must check for `null` and not assume the data is always present.**

Sources (backtest engine):
- `getOiClose` → `coinglass.open_interest_history_{tf}`, `exchange = 'Binance'`
- `getLiqLongUsd` / `getLiqShortUsd` → `coinglass.liquidation_history_{tf}`, `exchange = 'Binance'`
- `getLongShortRatio` → `coinglass.global_long_short_ratio_history_{tf}`, `exchange = 'Binance'`
- `getCurrentFundingRate` → `funding_research.funding`

`getRecentFundingRates(N)` returns up to `N` most recent funding rates whose `time ≤ currentBar.time`, **excluding** any rate at the exact current time only if it hasn't been observed yet (it's included once the bar with that timestamp passes through `processBar`).

`getAuxHistory(kind, N)` returns the last up-to-`N` values from the rolling history for the given series. Values may be `null` where the source had a gap. The history is built up bar by bar and **excludes the current bar** (no look-ahead).

---

## 10. Time invariants

All timestamps in the `TradingEnv` and all returned objects (`Bar.time`, `Position.entryTime`, `FilledOrder.fillTime`, `Trade.entryTime`, `Trade.exitTime`, `BacktestEvent.time`, `EquityPoint.timestamp`) are **Unix milliseconds**.

Bars arrive in strict chronological order. There are no gaps within a contiguous market session; if the underlying data source has a gap, the engine does not synthesize bars to fill it.

---

## 11. Resolution support (v1.0)

Six resolutions are supported by the backtest engine:

| Resolution string | TradingView label |
|---|---|
| `"1"` | 1m |
| `"15"` | 15m |
| `"30"` | 30m |
| `"60"` | 1h |
| `"240"` | 4h |
| `"1D"` | 1d |

For `"30"`, `MaValues` (`ma25`, `ma50`, `ma100`, `ma200`) is loaded from a precomputed PostgreSQL table (`klines_30m_metrics`). For other resolutions, MAs are computed at runtime from a rolling window of the bar history. If a precomputed value is missing for a particular bar (gap in source), the runtime fills with `{ ma25: 0, ma50: 0, ma100: 0, ma200: 0 }` — strategies should defensively check for zero before using MAs.

---

## 12. Position constraints

- `openLong()` / `openShort()` throw if any position is already open. Single-position semantics for market orders, kept for backward-compat with simple strategies.
- `placeLimitOrder()` doesn't have this constraint — each fill creates an independent position. Strategies that need multi-position trading use limit orders (and identify positions by the returned `orderId` → `FilledOrder.positionId`).
- `closePosition(positionId?)` without an id closes the first open position (insertion order). With an id, closes that specific position.
- `closeAllPositions(exitReason?)` closes every open position at the current bar's close with taker commission.
- `setStopLoss(positionId, price)` updates the SL on a specific position. `setStopLoss(price)` (single argument number) targets the first open position — kept for backward-compat with single-position strategies.

---

## 13. Quick reference — every TradingEnv method

| Method | Returns | Side effect |
|---|---|---|
| `openLong(size, options?)` | void | opens position at `currentBar.close`, taker commission |
| `openShort(size, options?)` | void | opens position at `currentBar.close`, taker commission |
| `closeLong()` | void | closes long at `currentBar.close`, exitReason `"close"`, taker |
| `closeShort()` | void | closes short at `currentBar.close`, exitReason `"close"`, taker |
| `placeLimitOrder(side, price, amount)` | `orderId` | queues pending limit order |
| `cancelOrder(orderId)` | `boolean` | removes pending order |
| `cancelAllOrders()` | void | removes all pending orders |
| `modifyOrderPrice(orderId, newPrice)` | `boolean` | mutates pending order price |
| `getPendingOrderList()` | `PendingOrder[]` | snapshot |
| `getPosition(positionId?)` | `Position \| null` | with computed unrealized pnl |
| `getPositionList()` | `Position[]` | all open, with computed unrealized pnl |
| `closePosition(positionId?, exitReason?)` | void | closes at `currentBar.close`, taker |
| `closeAllPositions(exitReason?)` | void | closes every open, taker |
| `setStopLoss(idOrPrice, price?)` | void | updates SL on a position |
| `setPositionTag(positionId, tag)` | void | annotates position; tag persists into the resulting `Trade` |
| `getBalance()` | number | realized balance (no unrealized PnL) |
| `getBarIndex()` | number | 0-indexed; -1 before first bar |
| `getCurrentBar()` | `Bar` | throws if no current bar yet |
| `getHistory(N)` | `Bar[]` | last N bars **excluding** current |
| `getOiClose()` | `number \| null` | OI close at current bar |
| `getLiqLongUsd()` | `number \| null` | long liquidations USD at current bar |
| `getLiqShortUsd()` | `number \| null` | short liquidations USD at current bar |
| `getLongShortRatio()` | `number \| null` | long/short ratio at current bar |
| `getCurrentFundingRate()` | `number \| null` | most recent funding rate ≤ current bar |
| `getRecentFundingRates(N)` | `number[]` | last up-to-N funding rates ≤ current bar |
| `getAuxHistory(kind, N)` | `Array<number \| null>` | rolling history excluding current |
| `getParam(key, defaultValue)` | `ParamValue` | typed via `defineStrategy<TParams>` |
| `getConfig()` | `Record<string, unknown>` | full raw JSON config object passed to the run |
| `emitEvent(type, data)` | void | records an event with `currentBar.time` for visualization |

---

## 14. What the SDK does NOT cover (yet)

- Cross-symbol references (single-symbol per backtest run in v1.0).
- Higher-timeframe references (single-resolution per backtest run).
- Slippage / partial fills / market impact.
- Built-in indicator helpers (RSI, ATR, EMA, Bollinger). Compute them yourself using `getHistory(N)`.
- Order book snapshots / trades tape.

These are **possible additive extensions** for `v1.x` (or breaking-change candidates for `v2.x`). Open a SDK PR with a concrete strategy use case if you need them.

---

## 15. Versioning promise

`v1.0.0` freezes the surface above. Future `v1.x` releases:
- **may** add new optional methods to `TradingEnv` (`method?(): T | null`),
- **may** add new optional fields to existing types (`{ existing: ..., newField?: ... }`),
- **may not** remove or rename anything,
- **may not** change the runtime semantics described in this file (sandbox limits, fill priority, commission split, funding signs, MFE definition, time-unit conventions, nullability rules).

Breaking changes are reserved for `v2.0.0` and ship with a migration guide.

The constant `API_VERSION` exported from `@solncebro/strategy-player-sdk` reflects the SDK version your strategy was bundled against. The runtime can read it for audit / mismatch detection.
