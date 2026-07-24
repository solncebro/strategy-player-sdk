# Changelog

All notable changes to `@solncebro/strategy-player-sdk` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — additive changes within a major line, breaking changes only on a major bump.

---

## [2.1.0] — 2026-07-25

First `2.x` release. Live execution is hardened after the July 2026 production incidents (doubled ladders, exchange-capped protective orders, silently reduced entries, stale open interest), money amounts in the contract are now explicitly named in USD, and protective levels carry the strategy's own exit reason. `2.0.0` was never published — this is the first tag shipping the breaking changes that were reserved for it.

**Breaking:** money fields renamed to `*Usd` (`Position.sizeUsd`, `Trade.sizeUsd`, `PendingOrder.amountUsd`, `FilledOrder.amountUsd`); `LiveExecutionPort` protective orders became SETS of exchange orders; `LiveExecutionPort.placeEntryOrder` returns a result object; `Strategy.onBeforeLimitFill` removed. Step-by-step migration at the end of this section.

### Fixed — live execution

- **`LiveStrategyRunner.sync()` is serialised by a re-entrancy lock** — a sync requested while one is already running (an exchange fill event landing mid-placement) no longer runs concurrently. Two concurrent passes both saw not-yet-placed orders and placed them TWICE: the SOXLUSDT 2026-07-15 incident — rung 1 filled instantly, the fill-triggered sync raced the placing sync, rungs 2/3 and the stop landed doubled (a $30k exchange position against an $18k book, the duplicates invisible to the book and unprotected). The re-entrant call now only marks a rerun; the lock owner repeats the pass until no rerun is pending, so mid-sync state changes still materialise. A flag, not a promise chain — a re-entrant caller returns immediately and cannot deadlock the pass it interrupted.

- **A finished trade cancels the remaining ladder rungs in the SAME sync** — `handleStopLossFilled`, `handleTakeProfitFilled`, `handleExternalPositionClose` and a full strategy-driven close (`closePosition`/`closeAllPositions` emptying the book) now request-cancel every remaining entry order immediately, instead of leaving the tail to the strategy's next-bar cleanup (up to a full kline later; operators were cancelling leftovers by hand). A PARTIAL close keeps the tail. The strategy's own later cancel of the gone rungs stays a harmless no-op.

### Removed (breaking)

- **`Strategy.onBeforeLimitFill` / `StrategySpec.onBeforeLimitFill`** — removed from the SDK contract. The documented boolean "veto" was never honored by the backtest runtime (the return value was dead code: an unconditional `break` discarded it, and the fill loop ignored it), so it misled strategy authors. The only consumer (`ma-bounce`) drives this hook inside its own coordinator, not via the SDK runtime — a pre-fill veto is a strategy-specific concern and now lives entirely in the strategy that needs it. **Breaking change** (removal of a public optional member) — shipped in this major release.

### Changed (breaking)

- **Money amounts in the contract are explicitly named in USD** (rename only — no change in values, units or behavior). `Position.size` → `Position.sizeUsd`, `Trade.size` → `Trade.sizeUsd`, `PendingOrder.amount` → `PendingOrder.amountUsd`, `FilledOrder.amount` → `FilledOrder.amountUsd`; the `TradingEnv` parameters follow (`openLong(sizeUsd)`, `openShort(sizeUsd)`, `placeLimitOrder(side, price, amountUsd)`). Every one of them always carried the QUOTE-currency notional (money), never a contract quantity — the old names read like a contract count and invited exactly that mix-up in strategies and hosts that also juggle real contract amounts (the live layer already used `amountUsd` / `contracts` side by side). Mechanical rename for consumers: rename the field accesses; positional arguments and semantics are untouched.

- **`LiveExecutionPort.placeEntryOrder` returns `PlaceEntryOrderResult | null`** instead of `string | null`, and a reduced landing is now topped up (live layer only). The result carries `exchangeOrderId` plus an optional `acceptedAmountUsd` — the notional the exchange actually accepted when it took the order SMALLER than requested. The runner shrinks the booked order to that value and immediately places the shortfall as a fresh order within the SAME sync (multi-pass placement), so a reduced-but-working order is never cancelled and the intended notional reaches the exchange without waiting for another bar. Ports that always land the full amount simply return `{ exchangeOrderId }`.

- **`LiveExecutionPort` protective orders are now SETS of exchange orders** (**breaking**, live layer only). Real exchanges cap the quantity of a single order (Bybit `maxMktOrderQty` silently truncated a 53.4M-contract stop to 43M — the BLASTUSDT 2026-07-15 incident: the "fully filled" capped stop left 10.4M contracts open and unprotected). The port now owns cap-splitting: `replaceStopLoss`/`replaceTakeProfit` take `previousExchangeOrderIdList: string[]` and return `ReplaceProtectiveOrderResult { exchangeOrderIdList, isComplete } | null`; `cancelStopLoss`/`cancelTakeProfit` take `{ exchangeOrderIdList }`. The runner tracks piece id lists (`getStopLossExchangeOrderIdList`/`getTakeProfitExchangeOrderIdList` replace the scalar getters), keeps an incomplete replacement unsynced (the next sync cancels the stored partial set and re-places), and snapshots the lists (`restoreSnapshot` maps pre-2.0 scalar ids to one-element lists). New host hooks: `invalidateProtectiveSync()` (force a re-place after the host detects the exchange lost part of the set) and `setProtectiveSyncHold(isHeld)` (freeze replace placements while a protective exit is being finalized; cancels keep running). Hosts must call `handleStopLossFilled`/`handleTakeProfitFilled` only when the exit is COMPLETE — every piece terminal and the position confirmed flat.

### Added

- **Entry-order cancels now wait for the exchange's confirmation** — `cancelOrder` on an order already resting on the exchange only MARKS it (`LiveEntryOrderState.isCancelRequested`, snapshotted); `sync()` retries the cancel every cycle and the order leaves the book solely when the port confirms the exchange accepted it. Previously a cancel lost to a transient failure dropped the order locally while it kept resting on the exchange — invisible to the book, still able to fill unnoticed. An order not yet placed is still dropped instantly, and a fill racing an unconfirmed cancel is still routed normally.

- **`EntryOrderFilledArgs.filledAmountUsd?`** — the USD notional ACTUALLY filled, for a partial fill the host crystallised by cancelling the remainder. The booked position is then sized from it (`amountUsd`, `contracts`, and the reported fill) instead of the order's full notional. Omitted in backtest/paper and for full fills, where a fill always consumes the whole order — behavior unchanged.

- **`EntryOrderFilledArgs.avgFillPrice?`** — the exchange's volume-weighted average fill price of the entry limit. A resting limit can fill BETTER than its price (the market ran past the level before the order landed); the book previously always recorded the limit target, so every average-entry-derived level (emergency stop, take target, journal average) drifted from reality — the ESPORTSUSDT 2026-07-19 incident: a rung booked at 0.026412 against a real 0.02712 fill. With the price supplied, the booked position carries the real entry (`entryPrice`, `contracts`, `runningBest`, and the `onOrderFill` price all derive from it); omitted (backtest/paper, where fills happen exactly at the limit) — behavior unchanged.

- **`ReplaceProtectiveOrderArgs.reason?`** — the strategy's exit-reason tag behind the protective level (e.g. `"stop_loss_emergency|15"`), passed by the runner from its stored `desiredStopLossReason` to `port.replaceStopLoss`. Lets the port recognise entry-anchored stops and re-derive their trigger from the EXCHANGE's own average entry instead of trusting the book's price alone (the book can lag real fills — same ESPORTSUSDT incident: the stop armed 1.2% below the honest level).

- **`oiProvider?: OiProvider` on `LiveStrategyRunnerOptions` / `MockTradingEnvOptions` / `BacktestContextOptions`** — a host-supplied read-through source of main-resolution open-interest candles keyed by bar open time. With a provider set, `getOiOhlc`/`getOiClose`/`getOiOhlcHistory`/`getAuxHistory("oi")` resolve through it at CALL time by the price bars' times, and the runner/runtime neither accumulates nor reads its own OI series (the live snapshot omits `oiHistory`/`currentOiBar`). This kills the frozen-copy divergence where an OI bucket published late stayed `null` in the runner forever while the host's store had long healed itself (the USUSDT 2026-07-15 missed-entry incident). Without the option, behavior is bit-for-bit unchanged. MTF (`resolution`-qualified) OI reads are not affected.

- **`LiveExecutionPort.splitEntryNotionalUsd?` + per-piece entry booking** — an optional port hook splitting an entry notional into per-order pieces under the exchange's per-order cap. `placeLimitOrder` books one entry order per piece (same price, own local id), so every piece fills, expires and cancels through the ordinary book lifecycle and an oversized rung can never be silently reduced or under-filled. Returns the FIRST piece's local id; strategies that cancel via `getPendingOrderList` iteration (rubber's pattern) reach every piece. Ports without caps omit the hook — behavior unchanged.
- **`LiveStrategyRunner.resyncProtectiveOrders()`** — invalidate + immediate re-sync of the protective sets in one call. The host's coverage watchdog uses it so a detected stop-coverage deficit heals on the watchdog cadence (seconds) instead of waiting for the next bar sync — an unprotected remainder must live as briefly as possible.
- **Exit-reason labels on protective orders in the LIVE runner** — `LiveStrategyRunner.setStopLoss`/`setTakeProfit` now store the optional 3rd `reason` argument (previously silently dropped — the TradingEnv contract declared it, the live runner ignored it, and every exchange stop fill was journaled as a generic `stop_loss`). New getters `getDesiredStopLossReason()`/`getDesiredTakeProfitReason()` let the host journal the real strategy reason (e.g. `"retrace_stop|25"`); the reasons ride the snapshot and clear together with the desired prices.
- **Exit-reason labels on protective orders** — `setStopLoss(id, price, reason?)` and `setTakeProfit(id, price, reason?)` now take an optional machine code recorded as `Trade.exitReason` when that level fires (falls back to `"stop_loss"` / `"take_profit"`). `PositionOptions.stopLossReason` / `takeProfitReason` do the same for levels armed at open. The code is presentation-neutral (e.g. `"take_profit_ma200"`, `"stop_loss_emergency|15"`) — the runtime never parses it; the player maps codes to human labels. Additive/optional; strategies that pass no reason keep the previous `"stop_loss"` / `"take_profit"` exit reasons. See `behavior.md` §4 "Exit-reason labels".
- **`Strategy.backtestChartIndicators?: Record<string, string[]>`** — per-resolution declaration of which chart indicators the backtest result page auto-shows (metric columns: `"cg_oi"`, `"cg_liq"`, `"cg_ls_ratio"`, `"volume_24h"`, `"funding"`, SMA columns). The page shows exactly the listed columns for the run's resolution; funding markers appear only if `"funding"` is listed (independent of the "Use Funding" cost toggle). Omitted / no entry → platform default (overlay SMAs, funding when "Use Funding" is on). Additive, optional; runtime-neutral (the player reads it, like `backtestColumns`). See `behavior.md` §19.
- **`LiveRunnerSnapshot` now carries rolling bar context** (`barHistory`, `oiHistory`, `currentBar`, `currentMaValues`, `currentOiBar`) so `LiveStrategyRunner.restoreSnapshot` rehydrates `getCurrentBar`/`getHistory`/`getMaValues`/OI accessors immediately after a restart — no warm-up replay required. All fields are optional: a snapshot from an older SDK restores the books only (prior behavior). Bounded by the runner's `historyLimit`.

### Fixed — backtest runtime & snapshot

- **Stop-loss is now evaluated on a position's ENTRY candle for limit fills.** Previously `checkStopLoss` ran only at the top of `processBar` (before `checkPendingOrders` and before `onBar`), so a position born on a bar (limit fill or market open) was never stop-checked on its own candle — its first check was the next bar. A limit-filled short whose entry candle spiked far past the stop rode to a catastrophic close (a real backtest showed −107% on a +116% single-candle pump) instead of stopping at the stop price. Now, after `checkPendingOrders` (new step 1.5b, `checkEntryBarStopLoss`), the **stop-loss only** of positions opened this bar via a limit fill is checked against the candle's adverse extreme and closes at the stop price. A limit fills only when price reaches its level, so the adverse extreme is a continuation *after* the fill — the breach is unambiguously post-entry (a limit entered at the adverse extreme, e.g. a long at the low, has no room past it and does not fire). Take-profit is intentionally not checked on the entry candle (favorable extreme sits on the pre-fill side), and market entries (open at `currentBar.close` in `onBar`) are unaffected. The stop must be set **at fill** (in `onOrderFill`) to exist on the entry candle. `behavior.md` §3/§4 updated. Behavior change — stored backtest results change only on re-run.
- **Live market entries (`openLong`/`openShort`)** now match the documented contract: they execute through the optional `LiveExecutionPort.openPositionMarket`, and **throw immediately** if the port does not implement it (previously the entry was silently dropped with only a `market_entry_unsupported` event). `behavior.md` §17 (live module) corrected — market entries ARE supported in live, they do not "throw — use placeLimitOrder" as previously stated.
- **`LiveStrategyRunner.restoreSnapshot` no longer leaves the runner in a crash-prone half-state.** Previously the snapshot dropped all bar context, so the first post-restore `getCurrentBar()` threw "No current bar" and `getHistory`/`getMaValues` silently returned empty/zero until the next bar. Bar context is now persisted and restored (see Added).
- **`feedClosedBar`/`catchUpBar` are now idempotent by bar time** — a closed bar at or before the last incorporated bar is skipped (no strategy run, no sync, no index advance). This lets snapshot-restore and post-restart catch-up compose without doubling history or drifting `getBarIndex()`/`PendingOrder.createdAtBar`. The shared advance logic is also de-duplicated into one private `advanceBar` helper (previously copy-pasted between the two methods).

### Migration from `1.8.0`

1. **Rename money accesses** (strategies and hosts): `Position.size` → `Position.sizeUsd`, `Trade.size` → `Trade.sizeUsd`, `PendingOrder.amount` / `FilledOrder.amount` → `amountUsd`. Calls to `openLong` / `openShort` / `placeLimitOrder` pass exactly the same values as before — only the parameter names changed.
2. **Drop `onBeforeLimitFill`** from strategies. A pre-fill veto is strategy-specific and belongs in the strategy's own coordinator; the SDK runtime never honored the returned boolean.
3. **Live hosts — `LiveExecutionPort`:** `placeEntryOrder` returns `{ exchangeOrderId, acceptedAmountUsd? }`; `replaceStopLoss` / `replaceTakeProfit` take `previousExchangeOrderIdList: string[]` and return `{ exchangeOrderIdList, isComplete }`; `cancelStopLoss` / `cancelTakeProfit` take `{ exchangeOrderIdList }`.
4. **Live hosts — runner:** read protective ids via `getStopLossExchangeOrderIdList()` / `getTakeProfitExchangeOrderIdList()` (the scalar getters are gone), and call `handleStopLossFilled` / `handleTakeProfitFilled` only once the exit is COMPLETE — every piece terminal and the position confirmed flat.
5. **Optional adoption** (no action required): `oiProvider`, `splitEntryNotionalUsd`, `avgFillPrice` / `filledAmountUsd` on fills, exit-reason labels, `backtestChartIndicators`, `resyncProtectiveOrders()` / `invalidateProtectiveSync()` / `setProtectiveSyncHold()`.

### Compatibility

- Snapshots written by a pre-`2.0` SDK restore without conversion: the scalar protective order ids map to one-element lists, and a snapshot lacking bar context restores the books only (prior behavior).
- Strategies that pass no exit reason keep the previous `"stop_loss"` / `"take_profit"` values in `Trade.exitReason`. Without `oiProvider`, open-interest reads are bit-for-bit as before.
- The entry-candle stop-loss check changes backtest numbers; results persisted earlier keep their stored values until re-run.
- `API_VERSION` bumped from `"1.8.0"` to `"2.1.0"`.

---

## [1.8.0] — 2026-06-06

Let a strategy declare its own extra columns for the backtest results table and provide per-trade display-ready values — so strategy-specific columns are abstracted into the strategy instead of hardcoded in the player UI.

### Added

- `Strategy.backtestColumns?: BacktestColumnSpec[]` — declares extra columns (`{ key, label, align?, tooltipKey? }`) the player adds to the trades table. Omitted/empty → only generic base columns.
- `Trade.display?: Record<string, unknown>` — per-trade, display-ready values for those columns (already-formatted strings, or a `BacktestTooltip` for tooltip cells).
- `TradingEnv.setPositionDisplay?(positionId, data)` — attach display data to a position; carried into `Trade.display` on close (mirrors `setPositionTag` → `Trade.tag`).
- Types `BacktestColumnSpec`, `BacktestTooltip`, `BacktestTooltipRow`.
- `API_VERSION` bumped from `"1.7.0"` to `"1.8.0"`.

### Why

Funding-specific columns (funding rate / period / range / min + MA-filter tooltip) were hardcoded in the player's `TradeTable`. With this, each strategy declares + formats its own columns; the player renders them generically. The runtime can't render React (sandbox), so the strategy ships a serializable schema + display-ready strings.

### Compatibility

- All additive/optional. Strategies without `backtestColumns` / `setPositionDisplay` behave exactly as before (no extra columns).

---

## [1.7.0] — Unreleased

Fix the `Trade.pnlPercent` formula, add `BacktestMetrics.totalPnlPercent`, and decouple reading funding rates from charging their cost via `applyFundingCost`.

### Added

- `BacktestMetrics.totalPnlPercent: number` — sum of per-trade `pnlPercent` (price-move %). Filled by the player's `calculateMetrics`.
- `BacktestContextOptions.applyFundingCost?: boolean` (default `true`) — when `false`, funding rates remain readable by the strategy (`getCurrentFundingRate` / `getRecentFundingRates`) but their cost is **not** deducted from position PnL.
- `API_VERSION` bumped from `"1.6.0"` to `"1.7.0"`.

### Fixed

- `Trade.pnlPercent` was `pnl / (entryPrice * size) * 100`, which is dimensionally wrong (an extra division by `entryPrice`) and produced values that varied wildly by symbol price and corrupted the Sharpe ratio. Now `pnl / size * 100` — the price-move percent (`≈ (exit - entry) / entry * 100` for long).

### Why

The platform needs a "Total PnL %" that is the sum of trade price-move percents (never ROI-of-deposit). That sum was meaningless while `pnlPercent` was wrong. Separately, funding-driven strategies need their funding rates to generate signals even when the user disables funding **cost** — previously turning funding off starved them of data and they produced zero trades.

### Compatibility

- `applyFundingCost` is optional and defaults to the prior behavior (cost applied).
- `totalPnlPercent` is additive. The `pnlPercent` correction changes reported values: runs persisted before this release keep their old stored `pnlPercent`/metrics until re-run.

---

## [1.6.0] — Unreleased

Add `Strategy.allowedResolutions?: string[]` — a strategy may declare which main timeframes it is allowed to run on.

### Added

- `Strategy.allowedResolutions?: string[]` (and `StrategySpec.allowedResolutions`): list of TradingView resolution strings (e.g. `["1"]`) the strategy may be executed on as the main timeframe. Distinct from `requiredTimeframes` (which declares *secondary* timeframes for MTF lookups). Semantics: omitted → no restriction (any supported resolution); one element → locked to that resolution; several → whitelist. The platform restricts the run/group forms and validates the chosen resolution server-side.

### Changed

- `API_VERSION` bumped from `"1.5.0"` to `"1.6.0"`.

### Why

Strategies like `kliner-funding` only work on a specific main timeframe (1m, where the `ma1000` gate is available); running them on another timeframe silently produced 0 trades (only `smaNotReady` events). Declaring the allowed timeframe lets the platform prevent the misconfiguration up front.

### Compatibility

- Optional field; strategies without it are unrestricted exactly as before.

---

## [1.5.0] — Unreleased

Lift the single-position restriction on `openLong()` / `openShort()`. The runtime now supports an arbitrary number of concurrent positions opened via market orders, symmetric to `placeLimitOrder()` which already allowed multi-position via per-fill `positionId` assignment.

### Changed

- `openLong(size, options?)` and `openShort(size, options?)` no longer throw when a position is already open. Each call creates a new position with a unique id assigned via `nextPositionId++` (same mechanism as limit-order fills).
- `API_VERSION` bumped from `"1.4.0"` to `"1.5.0"`.

### Why

Strategies that batch multiple concurrent signals (e.g., `kliner-funding`: funding rate triggers several orders with overlapping execution windows) were silently losing trades. The strategy would catch the throw and emit an `openPositionError` event, but the trade was never opened and not recorded. With the restriction lifted, strategies that want at-most-one-position semantics can enforce it themselves by checking `getPositionList()` before calling `openLong()`.

### Compatibility

- Strategies that open one position at a time work unchanged (the throw never fired for them).
- Strategies that wrapped `openLong()` calls in `try/catch` for the "position already open" error will no longer enter the catch branch — the open succeeds. Review such catch blocks if they relied on this behavior.

---

## [1.4.0] — Unreleased

Pass funding history events with timestamps into the custom `TradingEnv` adapter — symmetric to live exchange data where the funding interval is observable, not assumed. Enables adapters to derive things like `fundingIntervalHours` per bar from the historical timestamps the player already loaded from its database.

### Added

- `CreateTradingEnvOptions.fundingRateList?: FundingRate[]` — the full funding history loaded by the player for the run's symbol and date range. Optional; absent when the run was started with `useFunding === false`.

### Changed

- `API_VERSION` bumped from `"1.3.0"` to `"1.4.0"`.

### Compatibility

- Strategies without `createTradingEnv` work unchanged.
- Adapters that ignore the new field also work unchanged — the field is optional.

---

## [1.3.0] — Unreleased

Custom `TradingEnv` adapter — strategies can supply an infrastructure-level wrapper for the backtest runtime, symmetric to `LiveTradingEnv` in production. Fully additive: existing strategies (no `createTradingEnv`) work unchanged — the player passes the raw `StrategyRuntimeContext` directly.

### Added

- `CreateTradingEnvOptions` exported type: `{ parsedParams: unknown; symbol: string; resolution: string }`.
- `Strategy.createTradingEnv?(innerEnv: TradingEnv, options: CreateTradingEnvOptions): TradingEnv` — optional factory called once at the start of a backtest run. The returned `TradingEnv` is used by the player for every `init` / `onBar` / `onOrderFill` / `onBeforeLimitFill` / `onEnd` call. The inner `StrategyRuntimeContext` continues to handle `processBar` and result accumulation invisibly.
- `StrategySpec.createTradingEnv` (same signature) — available through `defineStrategy<TParams>()`.
- `behavior.md` §15: full specification of the adapter contract — when it runs, what to delegate, sandbox constraints, the symmetry with production `LiveTradingEnv`.

### Changed

- `API_VERSION` bumped from `"1.2.0"` to `"1.3.0"`.

### Compatibility

- Strategies without `createTradingEnv` work unchanged.
- The runtime `StrategyRuntimeContext` and `TradingEnv` interface are unchanged. Adapters simply wrap the existing surface — no new methods on `TradingEnv`.

---

## [1.2.0] — Unreleased

Per-strategy params validation. Strategy authors can now declare a `validateParams(parsed)` method that the backtest player calls on upload of a parameter JSON file. The platform no longer enforces a universal `config.global + comboBySymbol` schema — each strategy validates its own format. Fully additive.

### Added

- `ParamsValidationResult` exported type: `{ ok: boolean; error?: string }`.
- `Strategy.validateParams?(parsed: unknown): ParamsValidationResult` — optional method that the backtest player invokes on `POST /api/backtest/params/upload`. If `ok: false`, upload returns 400 with the strategy's `error` message. If the strategy doesn't export this method, any JSON object is accepted.
- `StrategySpec.validateParams` (same signature) — available through `defineStrategy<TParams>()`.
- `behavior.md` §14: full specification of the params validation contract (sandbox constraints, when it runs, how it relates to `env.getConfig()`).

### Changed

- `API_VERSION` bumped from `"1.1.0"` to `"1.2.0"`.

### Compatibility

- 1.1 strategies (no `validateParams`) work unchanged — the player accepts any JSON object as params if the strategy doesn't validate. Old `validateConfigStructure` (`config.global` + `comboBySymbol` enforcement) is removed from the platform; legacy ma-bounce JSON files continue to upload successfully because they remain valid JSON objects.
- Strategy implementations of `TradingEnv` don't need any changes — `validateParams` is a method on `Strategy`, not on `TradingEnv`.

---

## [1.1.0] — Unreleased

Multi-timeframe (MTF) support for strategies. Strategies can now read OHLCV bars, aux series, and MA values from timeframes other than the main backtest resolution. Fully additive — strategies that don't declare `requiredTimeframes` behave exactly as in 1.0.

### Added

- `Strategy.requiredTimeframes?: Record<string, number>` — optional declaration of which timeframes the strategy needs and how many bars of warm-up history each requires. Example: `{ "1D": 200, "240": 100 }`.
- `TimeframeData` exported type: `{ resolution, barList, auxSeriesData? }`. Used inside `BacktestContextOptions.timeframeDataList`.
- `BacktestContextOptions.timeframeDataList?: TimeframeData[]` — extra timeframes the runtime should make available to the strategy.
- New optional `resolution` parameter on existing `TradingEnv` methods: `getHistory`, `getOiClose`, `getLiqLongUsd`, `getLiqShortUsd`, `getLongShortRatio`, `getAuxHistory`. Without the argument they behave as in 1.0 (main TF). With the argument they return data from the corresponding secondary TF, advancing only as fast as fully-closed secondary bars (look-ahead protected).
- New optional method `TradingEnv.getMaValues?(resolution: string): MaValues` — computes SMA25/50/100/200 on a secondary timeframe over the loaded bars, with per-bar caching.
- `barDurationMs(resolution)` helper exported from `@solncebro/strategy-player-sdk/runtime`. Single source of truth for resolution → milliseconds mapping.
- `behavior.md` §11.1: full MTF specification — declaration, warm-up loading, look-ahead protection, API differences vs. main TF, error semantics.
- `MockTradingEnv` constructor accepts `timeframeDataList` for testing MTF strategies without a real database.

### Changed

- `API_VERSION` bumped from `"1.0.0"` to `"1.1.0"`.

### Compatibility

- 1.0 strategies (no `requiredTimeframes`, no `resolution` arguments) work without changes. They neither load nor see any secondary-TF data.
- Implementations of `TradingEnv` (`StrategyRuntimeContext` in this repo, `LiveTradingEnv` in ma-bounce) don't need to add the optional `resolution` parameter to existing methods — TypeScript permits implementations to omit optional parameters. They also don't need to implement `getMaValues?` (it's an optional method).
- Live trading bots that want to use MTF must implement the optional `resolution` parameter and subscribe to additional kline streams. Otherwise calls with `resolution` should throw a clear error (mirror of the runtime's "Timeframe not loaded" error).

---

## [1.0.0] — Unreleased

Initial public release. Source of truth carved out from `strategy-player/src/lib/backtest/`.

### Added

- Public `TradingEnv` interface with 29 methods covering market/limit orders, positions, bars, history, aux series (OI, liquidations, long/short ratio), funding, params, and event emission.
- `Strategy` contract: `name`, `version`, `params`, `onBar` (required), plus optional `init`, `onOrderFill`, `onBeforeLimitFill`, `onEnd`.
- `StrategyRuntimeContext` — the runtime implementation behind `TradingEnv`. Used by both the backtest player and `MockTradingEnv`. Single source of truth for SL/TP, limit order fills, funding application, MFE tracking, and equity computation.
- `defineStrategy<TParams>(spec)` — type-safe declarative helper. Narrows `env.getParam("key", default)` to the parameter's actual type.
- `MockTradingEnv` — feed/inspect wrapper around `StrategyRuntimeContext` for unit testing strategies in isolation.
- `behavior.md` — canonical runtime specification: lifecycle, fill priority, commission split, funding signs, MFE definition, sandbox limits, nullability, time invariants, supported resolutions.
- Two worked examples in `examples/`: SMA crossover, breakout with SL.
- Vitest test suite: runtime snapshot, mock delegation, strategy typing, examples compile through esbuild + sandbox load.
- `API_VERSION` constant exported from the root entry.

### Notes for migrators from strategy-player's bundled `BacktestContextImpl`

- `BacktestContextImpl` is renamed to `StrategyRuntimeContext`. Constructor signature, public methods, and behavior are 1-to-1.
- `BacktestContext` interface (parent of `TradingEnv`) is merged into `TradingEnv` directly. No external code in the player imported `BacktestContext` as a type.
- Internal types (`ExecutableStrategy`, `BacktestContextOptions`, `ClosePositionByIdArgs`, `LoadMaValuesArgs`, `LoadAuxSeriesArgs`, `RunBacktestArgs`, `BacktestResult`, `CompileFromFilesResult`, `ParamsFileSchema`, `CalculatePeriodMetricsArgs`, `StrategySource`) stay in the player and are not part of the public SDK.
- `BacktestContextOptions` and `BacktestContextResult` are exported from the SDK because they appear in the constructor and `getResult()` of `StrategyRuntimeContext`.
