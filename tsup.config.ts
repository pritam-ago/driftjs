import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli/index.ts",
  },
  // CJS on purpose. pg's entry point is `module.exports = new PG(...)`, which
  // cjs-module-lexer cannot analyse statically, so `import { Client } from "pg"`
  // throws at runtime under real ESM.
  format: ["cjs"],
  target: "node18",
  platform: "node",
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
  sourcemap: true,
  external: ["pg", "commander"],
});
