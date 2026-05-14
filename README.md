# strategy-player-sdk

Stable contract between [strategy-player](https://github.com/solncebro/strategy-player) backtest engine and external strategy repositories.

> **Single source of truth** for `TradingEnv` types and runtime behavior. Same code path runs in backtest and in live trading. Strategies depend only on this SDK.

## Install

```bash
yarn add git+ssh://git@github.com:solncebro/strategy-player-sdk.git#v1.0.0
```

For local development (when working on this SDK):

```bash
yarn add file:../strategy-player-sdk
```

## Quick start

```typescript
// my-strategy/src/index.ts
import { defineStrategy } from "@solncebro/strategy-player-sdk";

export default defineStrategy({
  name: "My Strategy",
  version: "1.0",
  params: {
    fastPeriod: 9,
    slowPeriod: 21,
    positionSize: 100,
  },
  init(env) {
    /* one-time setup before the first bar */
  },
  onBar(bar, maValues, env) {
    const fastPeriod = env.getParam("fastPeriod", 9);
    const slowPeriod = env.getParam("slowPeriod", 21);

    const history = env.getHistory(slowPeriod);
    if (history.length < slowPeriod) return;

    /* ... your trading logic ... */
  },
  onOrderFill(filledOrder, env) {
    /* react to limit/stop fills */
  },
  onEnd(env) {
    /* cleanup at the end of the run */
  },
});
```

Compile your strategy with `tsc` (or via esbuild bundling, which the player does at upload time), then upload through the strategy-player UI or pass the entry path to the backtest API.

## Public surface

- **`TradingEnv`** — the interface every strategy interacts with. Methods for opening/closing positions, placing limit orders, reading history and aux series, configuring stop loss, emitting events, and querying parameters. See `src/types.ts`.
- **`Strategy`** — the contract your default export must satisfy.
- **`defineStrategy<TParams>(spec)`** — type-safe declarative helper. Narrows `env.getParam("key", default)` to the parameter's actual type.
- **`Bar`, `MaValues`, `Position`, `FilledOrder`, `PendingOrder`, `Trade`, `EquityPoint`, `BacktestEvent`** and other domain types.
- **`API_VERSION`** — the SDK version your bundle was built against.

## Subpath exports

| Import path | Use for |
|---|---|
| `@solncebro/strategy-player-sdk` | Strategy code (types + `defineStrategy`) |
| `@solncebro/strategy-player-sdk/runtime` | Backtest runner (player only — `StrategyRuntimeContext`) |
| `@solncebro/strategy-player-sdk/testing` | Unit tests for strategies (`MockTradingEnv`) |

## Behavior specification

Read [`behavior.md`](./behavior.md) for the canonical runtime semantics — fill priority, commission split, funding signs, sandbox limits, time invariants, nullability rules. **The contract is the types plus this document.**

## Examples

See [`examples/`](./examples/):
- [`sma-crossover.ts`](./examples/sma-crossover.ts) — minimal SMA crossover strategy.
- [`breakout-sl.ts`](./examples/breakout-sl.ts) — breakout with stop loss and `onOrderFill` event emission.

## Testing your strategy

```typescript
import { describe, it, expect } from "vitest";
import { MockTradingEnv } from "@solncebro/strategy-player-sdk/testing";
import strategy from "./my-strategy";

describe("my strategy", () => {
  it("opens long on golden cross", () => {
    const mock = new MockTradingEnv(strategy);
    mock.feedBars([
      /* ... synthetic bars + maValues ... */
    ]);

    expect(mock.getOpenPositionList()).toHaveLength(1);
    expect(mock.getOpenPositionList()[0].side).toBe("long");
  });
});
```

## Versioning

`v1.0.0` freezes the API surface. Future `v1.x` releases add optional methods/fields only — never break or remove. Breaking changes ship as `v2.0.0` with a migration guide. See [`CHANGELOG.md`](./CHANGELOG.md).
