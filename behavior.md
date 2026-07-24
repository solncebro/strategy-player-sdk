# strategy-player-sdk — Behavior Specification

> **Audience:** authors of trading strategies who write code against `strategy-player-sdk`.
> **Status:** Canonical. Pinned to `v2.1.0`. Evolves alongside the SDK; breaking changes are called out inline — see CHANGELOG.md for the full history and migration notes.
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
  allowedResolutions?: string[];                 // main TFs the strategy may run on (v1.6) — see §2.1
  requiredTimeframes?: Record<string, number>;   // resolution → warm-up bar count (v1.1)
  validateParams?(parsed: unknown): ParamsValidationResult;                 // v1.2 — see §14
  createTradingEnv?(innerEnv: TradingEnv, options: CreateTradingEnvOptions): TradingEnv; // v1.3 — see §15

  init?(env: TradingEnv): void;                                            // before first bar
  onBar(bar: Bar, maValues: MaValues, env: TradingEnv): void;              // every bar
  onOrderFill?(order: FilledOrder, env: TradingEnv): void;                 // after pending or SL fill
  onEnd?(env: TradingEnv): void;                                            // after last bar
}
```

Required: `name`, `version`, `params`, `onBar`. Optional: `init`, `onOrderFill`, `onEnd`, `allowedResolutions`, `requiredTimeframes`, `validateParams`, `createTradingEnv`.

The runtime validates these requirements when loading the strategy. Missing required fields cause the load to fail before the first bar is fed.

### 2.1. allowedResolutions vs requiredTimeframes

Two separate timeframe declarations with different meaning:

- `allowedResolutions?: string[]` (v1.6) — which **main** timeframe(s) the strategy may run on. The platform restricts the run/group resolution selector to this list and rejects other resolutions server-side. Omitted → any supported resolution. One element → locked. Several → whitelist (first is the default selection). This is a platform-level guard; the runtime itself does not enforce it.
- `requiredTimeframes?: Record<string, number>` (v1.1) — which **secondary** timeframes to preload (resolution → warm-up bar count) for MTF lookups via `getHistory(N, res)`, `getMaValues(res)`, etc. (see §11.1).

Example (`kliner-funding`): `allowedResolutions: ["1"]` (main 1m, where `maValues.ma1000` is available) and `requiredTimeframes: { "60": 99, "240": 99 }` (reads 1h/4h moving averages as trend filters).

---

## 3. Lifecycle and bar pipeline

For each bar in chronological order, the runtime executes:

```
1. processBar(bar, maValues)         // internal — strategies don't call it
   1.1. push previous bar into barHistory + push aux values into auxHistory
   1.2. currentBarIndex++, currentBar = bar
   1.3. updateRunningBest()           // for every open position
   1.4. checkStopLoss(bar)            // SL/TP — see §4 Fill priority
   1.5. checkPendingOrders(bar)         // fill triggered pending limits, FIFO by createdAtBar
   1.5b. checkEntryBarStopLoss(bar)     // stop-loss ONLY, for positions opened via limit fill THIS bar — see §4
   1.6. applyFunding(bar)             // fund all open positions for any funding events ≤ bar.time
   1.7. equityList.push({ barIndex, timestamp, balance: effectiveBalance })

2. strategy.onBar(bar, maValues, env)
```

Step **1.4** checks positions that already existed at the start of the bar. Step **1.5b** additionally checks the stop-loss of positions *born on this bar via a limit fill* (in 1.5), so a protective stop can trigger on the position's own entry candle — see §4. Positions opened via a **market** order live in `onBar` (step 2, at `currentBar.close`); their first stop check is the next bar's 1.4.

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

### Entry-candle stop-loss (limit fills)

A position opened by a **limit fill** (step 1.5) has its **stop-loss** evaluated on that same entry candle, immediately after the fills (step 1.5b), against the candle's adverse extreme (short → `bar.high ≥ stopLoss`; long → `bar.low ≤ stopLoss`), closing **at the stop price** (taker, `exitReason: "stop_loss"`, `onOrderFill` fired with a synthetic `type: "stop"` order). This emulates an exchange stop-market placed the instant the entry fills: a limit fills only when price reaches its level, so the adverse extreme is a continuation *after* the fill and a breach is unambiguously post-entry (a limit entered at the candle's adverse extreme — e.g. a long at the low — has no room past it, so nothing fires). For the stop to exist on the entry candle the strategy must set it **at fill** (in `onOrderFill`), not only in `onBar`.

Not evaluated on the entry candle:
- **Take-profit** — the favorable extreme sits on the *pre-fill* side of a limit fill, so counting it would be a false fill. TP is first checked on the next bar (step 1.4).
- **Market entries** — they open at `currentBar.close` in `onBar` (after `processBar`), so the entry candle's excursion is entirely before entry; first stop check is the next bar's 1.4.

### Exit-reason labels

When a stop-loss or take-profit level fires, `Trade.exitReason` records the machine code the strategy attached to that level, or a default when none was given:
- `setStopLoss(id, price, reason?)` → the stop fires with `exitReason = reason ?? "stop_loss"` (both on the entry candle, §1.5b, and on later bars, §1.4).
- `setTakeProfit(id, price, reason?)` → the take fires with `exitReason = reason ?? "take_profit"`.
- `PositionOptions.stopLossReason` / `takeProfitReason` do the same for stops/takes armed at open.
- Strategy-driven market exits (`closePosition(id, reason?)` / `closeAllPositions(reason?)`) already record `reason` verbatim.

The code is opaque to the runtime — it is a stable, presentation-neutral token (e.g. `"take_profit_ma200"`, `"stop_loss_emergency|15"`, `"close_stop|8"`). The runtime never parses or renders it; the **player** owns the human label and language, mapping known codes to text (`"Take Profit (MA200)"`, `"Stop Loss (emergency −15%)"`, …) and prettifying unknown codes. Re-arming a level without a `reason` clears any prior one, so the label always reflects the level active at the moment it fired. Old runs (no reason) keep `"stop_loss"` / `"take_profit"`.

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
- Entry: `sizeUsd * rate` (charged immediately in account currency, deducted from `balance`).
- Exit: `sizeUsd * (exitPrice / entryPrice) * rate` (proportional to the closing notional).

Each `Trade` records its **total** commission (entry + exit) in `Trade.commission`. Net P&L per trade is:
```
netPnl = pnl - commission + funding
```

`Trade.pnlPercent` is the **price-move percent** of the position, independent of notional size:
```
pnlPercent = (pnl / sizeUsd) * 100        // ≈ (exit - entry) / entry * 100 for long
```
It is comparable across symbols of any price (it is **not** divided by `entryPrice` a second time, and **not** a ROI-of-deposit figure).

---

## 6. Funding model

Funding rates are 8-hour interval events on Binance Futures (00:00 / 08:00 / 16:00 UTC). The runtime applies them per-position:

```
fundingCost = position.sizeUsd * fundingRate.rate * sign
sign = -1 for long, +1 for short
```

So **positive funding rate ⇒ longs pay, shorts receive**. Negative rate is the reverse.

A funding event at time `T` is applied on the first bar with `bar.time ≥ T`, and only against positions that were opened before the event (`fundingRate.time ≥ position.entryTime`). Funding is then accumulated into `Trade.funding` and `balance`.

If `fundingRateList` is empty, funding is a no-op.

**Reading funding vs charging it (`applyFundingCost`, v1.7).** `getCurrentFundingRate()` / `getRecentFundingRates(N)` read from `fundingRateList` regardless of any flag — a funding-driven strategy always needs this data to produce signals. The separate `BacktestContextOptions.applyFundingCost` flag (default `true`) controls only whether the funding **cost** is deducted from position PnL inside `applyFunding`. The player wires `applyFundingCost` to the run's `useFunding` toggle, so turning funding "off" removes the cost from PnL but still feeds the strategy its funding rates (it keeps trading).

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

## 11. Resolution support (v1.1)

Six resolutions are supported by the backtest engine:

| Resolution string | TradingView label | Bar duration (ms) |
|---|---|---|
| `"1"` | 1m | 60_000 |
| `"15"` | 15m | 900_000 |
| `"30"` | 30m | 1_800_000 |
| `"60"` | 1h | 3_600_000 |
| `"240"` | 4h | 14_400_000 |
| `"1D"` | 1d | 86_400_000 |

For `"30"`, `MaValues` (`ma25`, `ma50`, `ma100`, `ma200`) is loaded from a precomputed PostgreSQL table (`klines_30m_metrics`). For other resolutions, MAs are computed at runtime from a rolling window of the bar history. If a precomputed value is missing for a particular bar (gap in source), the runtime fills with `{ ma25: 0, ma50: 0, ma100: 0, ma200: 0 }` — strategies should defensively check for zero before using MAs.

### 11.1. Multi-timeframe (MTF) lookups — v1.1

A strategy may read OHLCV bars, aux series (`oi` / `liqLong` / `liqShort` / `lsr`), and MA values from timeframes **other than** the main backtest resolution. To do this, the strategy declares which timeframes it needs:

```typescript
export default defineStrategy({
  name: "Trend-Filtered Pump Short",
  version: "1.0",
  params: { /* ... */ },
  requiredTimeframes: {
    "1D": 200,     // last 200 daily bars (warm-up window for MA200 on daily)
    "240": 100,    // last 100 4h bars
  },
  onBar(bar, maValues, env) {
    const dailyHistory = env.getHistory(20, "1D");        // last 20 closed daily bars
    const dailyMa = env.getMaValues!("1D");               // MA25/50/100/200 on daily, computed on the fly
    const dailyOi = env.getOiClose("1D");                 // OI close on the most recent closed daily bar
    /* ... */
  },
});
```

**What the runtime loads:** for each `(resolution, warmupBarCount)` pair in `requiredTimeframes`, the backtest engine fetches bars from `getKlineTable(resolution)` starting from `dateFrom - barDurationMs(resolution) * warmupBarCount` (so the strategy has full warm-up before the first main-TF bar) and the corresponding aux series from CoinGlass tables. Funding rate is shared across all timeframes (8-hour grid) and is **not** parameterized by resolution — use `getCurrentFundingRate()` / `getRecentFundingRates(N)` as before.

**Look-ahead protection:** on each main-TF bar with timestamp `T`, the runtime advances a per-resolution pointer to the **last fully-closed** secondary bar — i.e. the maximum index `i` such that `secondary.barList[i].time + barDurationMs(secondary) ≤ T`. Methods called with a secondary `resolution` argument see only data up to that index. This mirrors live trading, where WebSocket kline streams only push closed bars.

**API shape for MTF reads:**

| Method | Without `resolution` (main TF) | With `resolution` (secondary TF) |
|---|---|---|
| `getHistory(N, resolution?)` | last N bars **excluding** the current main bar | last N **closed** bars including the most recent closed one |
| `getOiClose(resolution?)` | OI at `currentBar.time` (main TF) | OI at the most recent closed secondary bar (or `null` if data is missing) |
| `getLiqLongUsd / getLiqShortUsd / getLongShortRatio(resolution?)` | same as before | secondary aux at the most recent closed bar |
| `getAuxHistory(kind, N, resolution?)` | rolling history excluding current main bar | rolling history of closed secondary bars |
| `getMaValues?(resolution)` | n/a — main MA comes via `onBar(bar, maValues, env)` | MA25/50/100/200 computed from `barList[0..currentIndex]` on the secondary TF; returns zeros until warm-up satisfied |

Note the **subtle difference**: `getHistory(N)` (main TF) excludes the current bar because the current bar is still in flight when `onBar` runs. `getHistory(N, "1D")` (secondary TF) **includes** the most recent closed daily bar because, by definition, that bar's close has already happened by the time the main-TF bar is processed.

**Error semantics:** calling `getHistory(N, "1D")` (or any other resolution-aware method) for a timeframe that is **not** declared in `requiredTimeframes` throws `Error: Timeframe "1D" is not loaded. Declare it in Strategy.requiredTimeframes.` Strategies must declare every timeframe they read.

**Backward compat:** strategies without `requiredTimeframes` (or with an empty object) load nothing extra. Calls to existing methods without a `resolution` argument behave exactly as in `v1.0`.

---

## 12. Position constraints

- `openLong()` / `openShort()` create a new position each call. Multiple concurrent positions are allowed; the runtime assigns each its own `id` via the same `nextPositionId++` mechanism as `placeLimitOrder()`. Single-position behavior (one open at a time) is the strategy's responsibility — call `getPositionList()` before `openLong()` if you want at-most-one semantics. (v1.5+; in v1.0–v1.4 these threw on an existing position.)
- `placeLimitOrder()` — each fill creates an independent position. Multi-position behavior is symmetric to `openLong`/`openShort` since v1.5.
- `closePosition(positionId?)` without an id closes the first open position (insertion order). With an id, closes that specific position.
- `closeAllPositions(exitReason?)` closes every open position at the current bar's close with taker commission.
- `setStopLoss(positionId, price, reason?)` updates the SL on a specific position. `setStopLoss(price)` (single argument number) targets the first open position — kept for backward-compat with single-position strategies. `reason` (id-form) is a machine code recorded as `Trade.exitReason` when the stop fires (see §4 Exit-reason labels); omitted → `"stop_loss"`.
- `setTakeProfit?(positionId, price, reason?)` sets/replaces the take-profit on an existing position — same semantics as passing `PositionOptions.takeProfit` at open: checked on the next bar's `processBar` before `onBar`, fills at the exact TP price with taker commission, and (like any TP fill) does NOT trigger `onOrderFill` — reconcile via `getPositionList()` in `onBar`. `exitReason = reason ?? "take_profit"` (§4). Declared optional so strategies can feature-detect it on older runtimes (`env.setTakeProfit?.(id, price)`). Unknown `positionId` is a no-op.

---

## 13. Quick reference — every TradingEnv method

| Method | Returns | Side effect |
|---|---|---|
| `openLong(sizeUsd, options?)` | void | opens position at `currentBar.close`, taker commission |
| `openShort(sizeUsd, options?)` | void | opens position at `currentBar.close`, taker commission |
| `closeLong()` | void | closes long at `currentBar.close`, exitReason `"close"`, taker |
| `closeShort()` | void | closes short at `currentBar.close`, exitReason `"close"`, taker |
| `placeLimitOrder(side, price, amountUsd)` | `orderId` | queues pending limit order |
| `cancelOrder(orderId)` | `boolean` | removes pending order |
| `cancelAllOrders()` | void | removes all pending orders |
| `modifyOrderPrice(orderId, newPrice)` | `boolean` | mutates pending order price |
| `getPendingOrderList()` | `PendingOrder[]` | snapshot |
| `getPosition(positionId?)` | `Position \| null` | with computed unrealized pnl |
| `getPositionList()` | `Position[]` | all open, with computed unrealized pnl |
| `closePosition(positionId?, exitReason?)` | void | closes at `currentBar.close`, taker |
| `closeAllPositions(exitReason?)` | void | closes every open, taker |
| `setStopLoss(idOrPrice, price?, reason?)` | void | updates SL on a position; `reason` → `Trade.exitReason` on fire (§4) |
| `setTakeProfit(positionId, price, reason?)` | void | sets/replaces TP on a position; `reason` → `Trade.exitReason` on fire (§4); optional method, feature-detect on older runtimes |
| `setPositionTag(positionId, tag)` | void | annotates position; tag persists into the resulting `Trade` |
| `setPositionDisplay(positionId, data)` | void | display-ready values for `Strategy.backtestColumns`; persists into `Trade.display` on close (v1.8) |
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

## 14. Params validation — v1.2

A strategy may export `validateParams?(parsed: unknown): ParamsValidationResult` to validate user-uploaded parameter JSON before it's stored in the backtest engine's database.

```typescript
export interface ParamsValidationResult {
  ok: boolean;
  error?: string;       // human-readable message, used by the player to surface 400 on upload
}

export default defineStrategy({
  name: "Funding Strategy",
  version: "1.0",
  params: { /* internal defaults */ },
  validateParams(parsed) {
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, error: "Params must be an object" };
    }
    const root = parsed as Record<string, unknown>;
    if (!root.settings || !root.periods) {
      return { ok: false, error: "Missing required keys: settings, periods" };
    }
    return { ok: true };
  },
  onBar(bar, ma, env) {
    const config = env.getConfig();          // full original JSON
    /* ... */
  },
});
```

**Where it runs:** in the backtest player, on `POST /api/backtest/params/upload`, the platform compiles the strategy bundle (the one already stored in the database for the selected strategyId) and invokes `validateParams(parsed)` on the uploaded JSON. If the result is `{ ok: false }`, the upload returns 400 with the strategy's `error` message. If the strategy doesn't export `validateParams`, the upload accepts any JSON object — the platform doesn't second-guess the strategy.

**Why it lives on the strategy:** each strategy knows the shape of its own parameter file. The platform doesn't impose a universal schema (no more `config.global + comboBySymbol` requirement). A strategy that needs per-symbol parameters checks for that structure itself; a strategy that needs `settings + periods` (like funding configs) checks for that. The same JSON is later available through `env.getConfig()` unchanged, so the strategy parses it itself at runtime.

**Sandbox:** `validateParams` runs in the same VM sandbox as `onBar` — same whitelist of globals, same 5s startup timeout when compiling. It must be pure (no I/O, no `fetch`, no `require`) and reasonably fast.

**Live trading bots** that consume the same strategy bundle don't need `validateParams` — they typically load their own validated config from disk. The method is a contract between strategy authors and the backtest UI.

---

## 15. Custom trading env adapter — v1.3

A strategy may export `createTradingEnv?(innerEnv, options): TradingEnv` — a **factory** that produces a `TradingEnv` adapter wrapping the runtime context. The backtest player invokes it once at the start of a run, before `init` and the bar loop. If the strategy doesn't export `createTradingEnv`, the player passes `innerEnv` (the raw `StrategyRuntimeContext`) directly to `init`/`onBar`/`onEnd`.

```typescript
export interface CreateTradingEnvOptions {
  parsedParams: unknown;   // raw params as stored in DB (e.g. file JSON uploaded by the user)
  symbol: string;          // selected backtest symbol
  resolution: string;      // backtest main timeframe (e.g. "1", "60")
}
```

**Why it exists:** production trading bots have their own `TradingEnv` implementation (e.g. `LiveTradingEnv` in `kliner-autotrade-funding`) that adapts exchange-specific or database-specific data sources into `StrategyRuntimeConfig`. In the backtest engine, the raw param JSON in DB may not match the runtime-config shape the strategy needs. `createTradingEnv` is the **symmetric extension point** that lets strategies bring their own infrastructure-adapter — without proxying or knowing about two formats inside the strategy itself.

**Typical implementation pattern** (in the strategy author's repo, not in the SDK):

```
src/strategy/                  ← pure strategy (production source of truth)
└── MyStrategy.ts              ← onBar reads env.getConfig() — only knows StrategyRuntimeConfig

src/infrastructure/            ← production adapter (Firebase / exchange)
└── LiveTradingEnv.ts          ← implements TradingEnv, builds StrategyRuntimeConfig from Firebase

src/backtest-infrastructure/   ← backtest adapter (file JSON)
└── BacktestTradingEnvAdapter.ts ← implements TradingEnv, builds StrategyRuntimeConfig from parsedParams

src/strategy-backtest/index.ts ← composition root for backtest bundle:
                                 default export = { ...inner, createTradingEnv: (env, opt) => new BacktestTradingEnvAdapter(env, opt) }
```

The strategy itself **does not know which environment it runs in**. Both adapters implement `TradingEnv`; both build the same `StrategyRuntimeConfig` shape through different data sources.

**Runtime semantics (what the player guarantees):**
- `createTradingEnv` is called **once**, right after the strategy is loaded and the `StrategyRuntimeContext` is constructed. The result is the `env` passed to `init`, every `onBar`, every `onOrderFill`, and `onEnd`.
- The inner `StrategyRuntimeContext` continues to handle `processBar`, `forceCloseAll`, and result accumulation — those aren't part of the `TradingEnv` interface and aren't seen by the strategy.
- Adapter methods that don't change behavior (`openLong`, `placeLimitOrder`, `getHistory`, etc.) **must delegate to `innerEnv`** so position tracking and history work correctly. Only methods the adapter wants to override (commonly `getConfig`) carry custom logic.
- The adapter runs inside the same sandbox as the strategy (same whitelist of globals, same 5s startup timeout when compiling). No I/O, no Node built-ins.

**Live trading bots:** ignore this extension point — they have their own production `TradingEnv` instantiated outside the SDK contract. `createTradingEnv` is purely a backtest-side convenience.

---

## 16. What the SDK does NOT cover (yet)

- Cross-symbol references (single-symbol per backtest run in v1.x).
- Slippage / partial fills / market impact.
- Built-in indicator helpers (RSI, ATR, EMA, Bollinger). Compute them yourself using `getHistory(N)` (with or without resolution).
- Order book snapshots / trades tape.

These are **possible additive extensions** for `v1.x` (or breaking-change candidates for `v2.x`). Open a SDK PR with a concrete strategy use case if you need them.

Higher-timeframe references — added in `v1.1` (see §11.1). Params validation — added in `v1.2` (see §14). Custom trading env adapter — added in `v1.3` (see §15).

---

## 17. Live module (`@solncebro/strategy-player-sdk/live`)

Runs the SAME strategy code outside the backtest player:

- **`PaperStrategyRunner`** — the exact backtest runtime fed with live closed bars ("real-time backtest"). Fills/SL/TP/commission semantics are identical to the player. `feedClosedBar(bar, maValues?)` + `drainNewEventList()` for incremental event forwarding (notifications, journaling).
- **`LiveStrategyRunner`** — executes the strategy against a real exchange through a **`LiveExecutionPort`** the host bot implements (place/cancel entry limit, replace/cancel stop-loss & take-profit, market close + fill notifications back into the runner). One runner = one symbol+direction.
  - **Desired-state sync**: the strategy's synchronous TradingEnv calls mutate local books; after every bar / fill handler the runner diffs the desired state against the exchange-known state and issues port operations (cancels → entry placements → market closes → protective replaces).
  - **Position aggregation**: the strategy holds N small positions (one per limit fill, as in the player) while the exchange holds ONE netted position — protective orders sync as ONE logical order for the total size, physically a SET of exchange orders when the size exceeds the exchange's per-order cap (the port owns the splitting; the runner tracks the piece id list via `getStopLossExchangeOrderIdList`/`getTakeProfitExchangeOrderIdList`). The strategy must keep one uniform protective price across its positions; the last `setStopLoss`/`setTakeProfit` price wins.
  - **Entry ladder cap-splitting**: `placeLimitOrder` books one entry order per piece via the optional `LiveExecutionPort.splitEntryNotionalUsd`, so a notional above the exchange's per-order cap is never silently reduced by the exchange. A reduced landing (`PlaceEntryOrderResult.acceptedAmountUsd` smaller than requested) shrinks the booked order and tops up the shortfall as a fresh order in the SAME sync (bounded to a few passes so a persistently-reducing exchange cannot loop forever).
  - **Sync is serialised**: a `sync()` requested while one is already running (e.g. an exchange fill event lands mid-placement) does not run concurrently — the re-entrant call only marks a rerun, which the lock owner executes before releasing, so mid-sync state changes still materialise without doubling placements.
  - **A finished/emptied position cancels the remaining ladder in the same sync**: `handleStopLossFilled`, `handleTakeProfitFilled`, `handleExternalPositionClose`, and any strategy-driven close that empties the book (`closePosition`/`closeAllPositions`) request-cancel every remaining entry order immediately, instead of leaving the tail for the strategy's next-bar cleanup.
  - **`cancelOrder` confirms against the exchange**: an order not yet placed is dropped locally right away; a placed order is only MARKED for cancellation and leaves the book once the port confirms the cancel in `sync()` — a cancel lost to a transient failure keeps the order tracked and retries every cycle instead of orphaning it.
  - **Protective coverage watchdog hooks**: `resyncProtectiveOrders()` invalidates and immediately re-syncs the protective sets (for a host's coverage watchdog to heal a detected deficit on its own cadence instead of waiting for the next bar); `setProtectiveSyncHold(isHeld)` freezes protective REPLACE placements while a protective exit is being finalized (cancels still run).
  - **`oiProvider`** (`LiveStrategyRunnerOptions.oiProvider`): a host-supplied read-through OI source keyed by bar open time. When set, `getOiOhlc`/`getOiClose`/`getOiOhlcHistory`/`getAuxHistory("oi")` resolve through it at CALL time instead of the runner's own frozen series, and the snapshot omits `oiHistory`/`currentOiBar`. `PaperStrategyRunner`/`MockTradingEnv` accept the same option.
  - **Real fill price, not the limit target**: a live limit fill reported through `handleEntryOrderFilled` may carry the exchange's volume-weighted `avgFillPrice`; the runner books the position — `entryPrice`, `contracts`, `runningBest`, and the `onOrderFill` price — at that fill price, falling back to the order's limit price only when it is omitted. A resting limit can fill better than its level (the market ran past it before the order landed), so every average-entry-derived level (stop, take, journal) anchors to the real fill, not the target. Backtest/paper omit it — fills there happen exactly at the limit price.
  - **Protective reason forwarding**: the runner passes the active stop level's machine reason code (§4, e.g. `stop_loss_emergency|15`) to `LiveExecutionPort.replaceStopLoss` (`reason`), so a host port can recognise entry-anchored levels and re-derive their price from the exchange's own average entry instead of trusting the strategy's book price.
  - **TP semantics mirror the player**: `handleTakeProfitFilled` does NOT call `onOrderFill`; the strategy reconciles via `getPositionList()` on the next bar.
  - **Catch-up mode** (`startCatchUp`/`completeCatchUp`): replay history through the strategy without touching the exchange, then sync only the final desired state — for manual late entries and restart recovery.
  - **Snapshot/restore** (`getSnapshot`/`restoreSnapshot`): persists the order/position books, the rolling bar/OI history + current bar/MA, and the optional `Strategy.getStateSnapshot()`/`restoreStateSnapshot()` payload, so a host can resume after a restart with `getCurrentBar()`/`getHistory(N)`/`getMaValues`/OI accessors working **immediately** — no warm-up replay required. The bar context is bounded by the runner's `historyLimit`. (Backward-compat: a snapshot taken by an older SDK without bar context restores the books only; then `getCurrentBar()` throws until the first `feedClosedBar`/`catchUpBar`, exactly as before.)
  - **Idempotent bar feed**: `feedClosedBar`/`catchUpBar` skip a closed bar whose `time ≤` the last incorporated bar (no strategy run, no sync, no index advance). So a host that, after a restore, replays already-seen or missed klines via `catchUpBar`/`feedClosedBar` will **not** double its history or drift the bar index — restore and catch-up compose safely.
  - **Market entries in live ARE supported**: `openLong`/`openShort` record a desired market entry that the post-bar sync executes through the optional `LiveExecutionPort.openPositionMarket` (firing `onOrderFill` with `type: "market"`, emitting `market_entry_filled`). If the host's port does **not** implement `openPositionMarket`, `openLong`/`openShort` **throw immediately** — the entry is never silently dropped. Strategies that only use `placeLimitOrder` never touch this path.
  - Unsupported in live: MTF history (`getHistory(N, resolution)` returns `[]`), aux series (null), funding (null).

---

## 18. Backtest result columns — v1.8

A strategy can declare extra columns for the player's trades table and supply per-trade values, so strategy-specific columns live in the strategy (the runtime can't render UI):

```typescript
backtestColumns: [
  { key: "funding", label: "Funding", align: "right" },
  { key: "range", label: "Range", align: "left", tooltipKey: "filters" },
];
```

Per trade, the strategy attaches **display-ready** values (already-formatted strings) keyed by column `key`; a `tooltipKey` cell reads a `BacktestTooltip` (`{ rows: [{ label, value, ranges: [{ text, matched }] }] }`):

```typescript
env.openLong(sizeUsd);
const pos = env.getPositionList()[0];
env.setPositionDisplay?.(pos.id, {
  funding: "-0.45%",
  range: "0.1%–0.5%",
  filters: { rows: [{ label: "MA5m200", value: "+12.3%", ranges: [{ text: "6%…50%", matched: true }] }] },
});
```

These ride into `Trade.display` on close (exactly like `setPositionTag` → `Trade.tag`). The player renders columns generically from the schema + `Trade.display`; it does no formatting or decoding. Strategies that declare nothing show only the generic base columns. The strategy owns all formatting (percent, K/M/B, matched-range detection).

---

## 19. Backtest chart indicators (per-resolution)

A strategy declares which chart indicators the backtest result page should auto-show, keyed by resolution — the strategy owns *what to visualize*, the platform just executes it:

```typescript
backtestChartIndicators: { "30": ["cg_oi"], "1D": ["sma_200"] };
```

Values are metric columns: `"cg_oi"` (open interest), `"cg_liq"` (liquidations), `"cg_ls_ratio"`, `"volume_24h"`, `"funding"`, or SMA columns (`"sma_25"`, …). Rules:

- The page auto-shows **exactly** the columns listed for the run's resolution — nothing more. So SMAs used only on one timeframe don't leak onto others.
- **Funding markers** appear only if `"funding"` is in the list. This is independent of the run's **"Use Funding" toggle**, which controls *only* whether funding cost enters PnL (like commission) — never chart display.
- No entry for a resolution (or field omitted) → platform default: overlay SMAs, funding only when "Use Funding" is on (backward-compatible).
- Everything stays user-toggleable via the panel buttons; the declaration sets the *initial* set.

Runtime-neutral: the SDK runtime does not act on this field — the **player** reads it from the compiled strategy (like `backtestColumns`). Additive, optional.

---

## 20. Versioning promise

`v1.0.0` froze the surface; `v1.1.0` MTF; `v1.2.0` params validation; `v1.3.0` custom trading env adapter; `v1.4.0` funding history in adapter options; `v1.5.0` multi-position market opens; `v1.6.0` `allowedResolutions`; `v1.7.0` `totalPnlPercent` + `applyFundingCost` + `pnlPercent` formula bugfix; `v1.8.0` strategy-declared backtest columns (`Strategy.backtestColumns` + `Trade.display` + `setPositionDisplay`); `v2.1.0` first `2.x` release — money fields renamed to `*Usd`, live protective orders became sets of exchange orders, `placeEntryOrder` returns a result object, `onBeforeLimitFill` removed, plus exit-reason labels, `oiProvider`, entry-notional splitting and the entry-candle stop-loss check (`v2.0.0` was never published; see CHANGELOG.md for the migration guide from `v1.8.0`). Future `v2.x` releases:
- **may** add new optional methods to `TradingEnv` (`method?(): T | null`),
- **may** add new optional parameters to existing `TradingEnv` methods (`foo(a, b?: string)`),
- **may** add new optional fields to existing types (`{ existing: ..., newField?: ... }`),
- **may not** remove or rename anything,
- **may not** change the runtime semantics described in this file (sandbox limits, fill priority, commission split, funding signs, MFE definition, time-unit conventions, nullability rules, look-ahead protection).

Breaking changes are reserved for the next major version and always ship with a migration guide.

The constant `API_VERSION` exported from `@solncebro/strategy-player-sdk` reflects the SDK version your strategy was bundled against. The runtime can read it for audit / mismatch detection.
