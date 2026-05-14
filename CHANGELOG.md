# Changelog

All notable changes to `@solncebro/strategy-player-sdk` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — additive changes only in `v1.x`, breaking changes reserved for `v2.0.0`.

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
