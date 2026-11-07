// `npm test`: the fast tier (v0.6.1 T0). Tests run inside workerd against local bindings only (remoteBindings: false), with
// D1 built from schema.sql (DB) and from the oldest schema in git (DB_V01, for the pre-migrate fallbacks). scripts/check.sh
// stays the full gate; this tier is for rules and failure paths a live Worker cannot reach.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { unstable_splitSqlQuery } from "wrangler";

// wrangler reads .dev.vars from the config's own directory and has no switch for it, so the tests get a copy of
// wrangler.jsonc in an empty directory: a developer's local secrets never change what a test sees (ci.sh does the same).
const dir = mkdtempSync(join(tmpdir(), "botline-test-")), configPath = join(dir, "wrangler.jsonc");
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const config = readFileSync("wrangler.jsonc", "utf8");
if (!config.includes('"main": "src/index.ts"')) throw new Error("vitest.config.mts: wrangler.jsonc main moved");
writeFileSync(configPath, config.replace('"main": "src/index.ts"', `"main": ${JSON.stringify(resolve("src/index.ts"))}`));

// D1's exec() splits on newlines, and schema.sql has multi-line statements: wrangler's own splitter, as readD1Migrations uses.
const split = (file: string) => unstable_splitSqlQuery(readFileSync(file, "utf8"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath },
      remoteBindings: false,
      miniflare: {
        d1Databases: { DB_V01: "botline-test-v01" },
        bindings: { TEST_SCHEMA: split("schema.sql"), TEST_SCHEMA_V01: split("scripts/fixtures/schema-v0.1.sql") },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], setupFiles: ["test/setup.ts"] },
});
