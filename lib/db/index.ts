import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { serverEnv } from "@/lib/env";
import * as schema from "./schema";

/**
 * A single pooled connection reused across requests. In serverless
 * environments this is created per cold start, which is the expected
 * pattern for postgres.js + Vercel + Supabase's connection pooler.
 *
 * `prepare: false` — NOT optional with the connection string this project
 * tells people to use.
 *
 * postgres.js turns parameterized queries into named prepared statements by
 * default. Supabase's pooler (Supavisor) in TRANSACTION mode — port 6543,
 * which is exactly what `.env.example` recommends for serverless — hands
 * the underlying connection back to the pool after every statement, so a
 * statement prepared on one physical connection is simply not there when
 * the next query lands on another. Supabase's own documentation lists "does
 * not support prepared statements" as a property of transaction mode.
 * Leaving the default on means queries that work locally (direct
 * connection) fail in production, intermittently, under pool pressure —
 * the worst possible failure shape.
 *
 * Disabling it unconditionally is deliberate rather than
 * conditional-on-the-URL: guessing the pooling mode from the connection
 * string is a heuristic that is silently wrong the moment the URL changes,
 * and being wrong in that direction breaks every query. The cost of being
 * wrong in THIS direction is a lost optimization on a direct connection,
 * which is invisible at this project's scale. If a deployment ever pins a
 * session-mode (5432) or direct connection and measures a reason to turn
 * them back on, this is the one line to change.
 */
const queryClient = postgres(serverEnv.DATABASE_URL, {
  max: 1,
  prepare: false,
});

export const db = drizzle(queryClient, { schema });
