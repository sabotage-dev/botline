// Runs before each test file: both schemas, idempotently (every statement is IF NOT EXISTS).
import { testEnv } from "./helpers";

const env = testEnv();
await env.DB.batch(env.TEST_SCHEMA.map((q) => env.DB.prepare(q)));
await env.DB_V01.batch(env.TEST_SCHEMA_V01.map((q) => env.DB_V01.prepare(q)));
