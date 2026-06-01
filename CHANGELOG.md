# Changelog

All notable changes to `@solncebro/strategy-player-sdk` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — additive changes only in `v1.x`, breaking changes reserved for `v2.0.0`.

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
