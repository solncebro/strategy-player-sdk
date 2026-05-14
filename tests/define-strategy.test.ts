import { describe, it, expect, expectTypeOf } from "vitest";
import { defineStrategy } from "../src";
import type { Strategy } from "../src";

describe("defineStrategy<TParams>", () => {
  it("returns a Strategy-shaped object", () => {
    const strategy = defineStrategy({
      name: "typed",
      version: "1.0",
      params: { x: 5, name: "abc", flag: true },
      onBar() {
        /* no-op */
      },
    });

    expectTypeOf(strategy).toMatchTypeOf<Strategy>();
    expect(strategy.name).toBe("typed");
    expect(strategy.version).toBe("1.0");
    expect(strategy.params).toEqual({ x: 5, name: "abc", flag: true });
    expect(typeof strategy.onBar).toBe("function");
  });

  it("typed env.getParam returns narrowed type when key is in TParams", () => {
    interface Params extends Record<string, number | string | boolean> {
      stopLoss: number;
      mode: string;
      enabled: boolean;
    }

    defineStrategy<Params>({
      name: "narrow",
      version: "1.0",
      params: { stopLoss: 0.05, mode: "aggressive", enabled: true },
      onBar(_bar, _ma, env) {
        const sl = env.getParam("stopLoss", 0);
        const mode = env.getParam("mode", "");
        const enabled = env.getParam("enabled", false);

        expectTypeOf(sl).toEqualTypeOf<number>();
        expectTypeOf(mode).toEqualTypeOf<string>();
        expectTypeOf(enabled).toEqualTypeOf<boolean>();
      },
    });
  });

  it("optional callbacks are present when provided", () => {
    const strategy = defineStrategy({
      name: "all-hooks",
      version: "1.0",
      params: {},
      init() {
        /* no-op */
      },
      onBar() {
        /* no-op */
      },
      onOrderFill() {
        /* no-op */
      },
      onBeforeLimitFill() {
        return true;
      },
      onEnd() {
        /* no-op */
      },
    });

    expect(strategy.init).toBeDefined();
    expect(strategy.onOrderFill).toBeDefined();
    expect(strategy.onBeforeLimitFill).toBeDefined();
    expect(strategy.onEnd).toBeDefined();
  });
});
