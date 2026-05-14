import { describe, it, expect } from "vitest";
import { build } from "esbuild";
import vm from "node:vm";
import path from "node:path";

const ALLOWED_GLOBALS: Record<string, unknown> = {
  console,
  Math,
  Date,
  JSON,
  Array,
  Object,
  Number,
  String,
  Boolean,
  Map,
  Set,
  Error,
  RegExp,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  Infinity,
  NaN,
  undefined,
};

const EXAMPLE_LIST = [
  "examples/sma-crossover.ts",
  "examples/breakout-sl.ts",
];

describe("examples compile and load in sandbox", () => {
  for (const examplePath of EXAMPLE_LIST) {
    it(`${examplePath} bundles and exports a valid Strategy`, async () => {
      const absolutePath = path.resolve(examplePath);

      const result = await build({
        entryPoints: [absolutePath],
        bundle: true,
        format: "cjs",
        platform: "neutral",
        write: false,
        target: "es2020",
      });

      expect(result.outputFiles).toBeDefined();
      expect(result.outputFiles!.length).toBe(1);

      const bundledCode = result.outputFiles![0].text;

      const moduleExports: Record<string, unknown> = {};
      const sandbox = {
        ...ALLOWED_GLOBALS,
        module: { exports: moduleExports },
        exports: moduleExports,
      };

      vm.runInNewContext(bundledCode, sandbox, {
        filename: "strategy.js",
        timeout: 5000,
      });

      const strategy = ((sandbox.module as { exports: Record<string, unknown> }).exports.default
        ?? sandbox.module.exports) as Record<string, unknown>;

      expect(typeof strategy).toBe("object");
      expect(typeof strategy.name).toBe("string");
      expect((strategy.name as string).length).toBeGreaterThan(0);
      expect(typeof strategy.version).toBe("string");
      expect(typeof strategy.onBar).toBe("function");
    });
  }
});
