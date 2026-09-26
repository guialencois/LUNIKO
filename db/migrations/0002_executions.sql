-- Fase 3: tabelas de execução, vinculadas a workflows (Fase 2) e workspaces
-- (Fase 1). Nova migration — 0000 e 0001 não são modificadas.
-- Regenerate with `npm run db:generate` if you change
-- lib/db/schema/executions.ts.

CREATE TABLE IF NOT EXISTS "executions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'queued'
    CHECK ("status" IN ('queued', 'running', 'success', 'error', 'cancelled')),
  "document" jsonb NOT NULL,
  "trigger_type" text NOT NULL DEFAULT 'manual' CHECK ("trigger_type" IN ('manual')),
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "duration_ms" integer,
  "error" jsonb,
  "created_by" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "executions_workflow_idx" ON "executions" ("workflow_id");
CREATE INDEX IF NOT EXISTS "executions_workspace_idx" ON "executions" ("workspace_id");

CREATE TABLE IF NOT EXISTS "execution_nodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "execution_id" uuid NOT NULL REFERENCES "executions"("id") ON DELETE CASCADE,
  "node_id" text NOT NULL,
  "node_type" text NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('success', 'error')),
  "input" jsonb,
  "output" jsonb,
  "error" jsonb,
  "duration_ms" integer NOT NULL,
  "started_at" timestamptz NOT NULL,
  "finished_at" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "execution_nodes_execution_idx" ON "execution_nodes" ("execution_id");

ALTER TABLE "executions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "execution_nodes" ENABLE ROW LEVEL SECURITY;

-- Same pattern as workflows (0001): a user can see an execution only if
-- they're a member of its workspace.
CREATE POLICY "executions_select_member" ON "executions"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "workspace_members" wm
      WHERE wm."workspace_id" = "executions"."workspace_id"
        AND wm."user_id" = auth.uid()
    )
  );

-- execution_nodes has no workspace_id of its own — authorize by joining
-- through its execution, which is already workspace-scoped above.
CREATE POLICY "execution_nodes_select_member" ON "execution_nodes"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "executions" e
      JOIN "workspace_members" wm ON wm."workspace_id" = e."workspace_id"
      WHERE e."id" = "execution_nodes"."execution_id"
        AND wm."user_id" = auth.uid()
    )
  );

-- As with workflows (0001_workflows.sql): writes go through the app's own
-- DATABASE_URL connection (not subject to RLS), authorized in application
-- code (requireWorkspaceMembership) — no INSERT/UPDATE/DELETE policy here
-- by design, not by oversight.
