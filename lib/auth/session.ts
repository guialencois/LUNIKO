import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { workspaceMembers, workspaces } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

/**
 * Authentication !== authorization. This module is the single place that
 * answers "who is this user, and which workspaces can they touch" — every
 * server-side resource access in later phases should go through here rather
 * than re-implementing the check inline.
 */

export async function getCurrentUser() {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

/** Redirects to /login if there is no authenticated user. */
export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** All workspaces the given user belongs to, with their role in each. */
export async function getUserWorkspaces(userId: string) {
  return db
    .select({
      workspaceId: workspaces.id,
      name: workspaces.name,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId));
}

/**
 * Throws unless `userId` is a member of `workspaceId`. Call this at the top
 * of every route/action that touches a workspace-scoped resource — never
 * trust a workspaceId that came from the client without this check.
 */
export async function requireWorkspaceMembership(
  userId: string,
  workspaceId: string
) {
  const [match] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .limit(1);

  if (!match) {
    throw new Error("FORBIDDEN: user is not a member of this workspace");
  }

  return match;
}
