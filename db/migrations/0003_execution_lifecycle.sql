-- Fase 4C: colunas necessárias para o lifecycle assíncrono descrito em
-- docs/async-execution.md. Nova migration — 0000/0001/0002 não são
-- modificadas. Regenerate with `npm run db:generate` if you change
-- lib/db/schema/executions.ts.

ALTER TABLE "executions"
  ADD COLUMN IF NOT EXISTS "result" jsonb,
  ADD COLUMN IF NOT EXISTS "claim_attempts" integer NOT NULL DEFAULT 0;

-- No RLS change needed: the existing "executions_select_member" policy
-- (0002_executions.sql) is row-level, not column-level — it already
-- covers these two new columns for anyone who could already read the row.
-- No new write policy either, for the same reason every other write policy
-- in this project is absent by design: writes go through the app's own
-- DATABASE_URL connection (not subject to RLS), authorized in application
-- code — see server/execution/execution-repository.ts for the two
-- authorization models (MODELO 1 / MODELO 2) that govern who can call
-- which function.
