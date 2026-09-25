-- Phase 1: workspaces + workspace_members only.
-- Regenerate with `npm run db:generate` after installing dependencies if you
-- change lib/db/schema/*.ts — this file is provided so the project has a
-- working baseline without needing `drizzle-kit generate` to run first.

CREATE TABLE IF NOT EXISTS "workspaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "workspace_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL,
  "role" text NOT NULL DEFAULT 'member' CHECK ("role" IN ('owner', 'admin', 'member', 'viewer')),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_members_workspace_user_idx"
  ON "workspace_members" ("workspace_id", "user_id");

CREATE INDEX IF NOT EXISTS "workspace_members_user_idx"
  ON "workspace_members" ("user_id");

-- Row Level Security. Apply after running this migration (Supabase SQL editor
-- or included here since Supabase Postgres supports it natively).
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_members" ENABLE ROW LEVEL SECURITY;

-- A user can see a workspace only if they are a member of it.
CREATE POLICY "workspaces_select_member" ON "workspaces"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "workspace_members" wm
      WHERE wm."workspace_id" = "workspaces"."id"
        AND wm."user_id" = auth.uid()
    )
  );

-- A user can see their own membership rows, and other members' rows in
-- workspaces they belong to (needed to render a member list).
CREATE POLICY "workspace_members_select_same_workspace" ON "workspace_members"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "workspace_members" wm
      WHERE wm."workspace_id" = "workspace_members"."workspace_id"
        AND wm."user_id" = auth.uid()
    )
  );

-- Inserts/updates/deletes are intentionally NOT covered by a permissive
-- policy here: writes go through server-side code (server/workflows/*,
-- lib/auth/*) connecting with the app's own DATABASE_URL, a direct Postgres
-- connection distinct from Supabase's anon/service-role API keys — that
-- connection is not subject to RLS at all (RLS applies to roles going
-- through PostgREST/the Supabase client, not to this direct connection).
-- Authorization for writes is therefore enforced entirely in application
-- code (requireWorkspaceMembership in lib/auth/session.ts), not by a
-- Postgres policy, so there is deliberately no INSERT/UPDATE/DELETE policy
-- here to keep that one place of truth instead of duplicating the rule.
