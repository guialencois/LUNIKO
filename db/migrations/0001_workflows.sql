-- Fase 2: tabela de workflows, vinculada a workspaces (Fase 1).
-- Regenerate with `npm run db:generate` if you change lib/db/schema/workflows.ts.

CREATE TABLE IF NOT EXISTS "workflows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft', 'active', 'inactive')),
  "document" jsonb NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "workflows_workspace_idx" ON "workflows" ("workspace_id");

ALTER TABLE "workflows" ENABLE ROW LEVEL SECURITY;

-- Same pattern as workspaces/workspace_members (0000_init.sql): a user can
-- see a workflow only if they're a member of its workspace. Writes go
-- through server-side code connecting via the app's own DATABASE_URL (a
-- direct Postgres connection, not Supabase's service-role API key — that
-- connection is simply not subject to RLS), with authorization enforced in
-- server/workflows/* via requireWorkspaceMembership — not duplicated here.
CREATE POLICY "workflows_select_member" ON "workflows"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "workspace_members" wm
      WHERE wm."workspace_id" = "workflows"."workspace_id"
        AND wm."user_id" = auth.uid()
    )
  );
