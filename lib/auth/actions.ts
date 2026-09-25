"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { workspaces, workspaceMembers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function signOutAction() {
  const supabase = createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * Phase 1 has no onboarding flow yet, so the first time a user reaches the
 * dashboard with zero workspaces, we create one "Meu workspace" for them as
 * owner. This keeps every later query workspace-scoped from day one instead
 * of special-casing "user with no workspace" throughout the app.
 */
export async function ensureDefaultWorkspace(userId: string, userEmail: string) {
  const existing = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);

  if (existing.length > 0) {
    return existing[0].workspaceId;
  }

  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: `Workspace de ${userEmail}` })
      .returning({ id: workspaces.id });

    await tx.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId,
      role: "owner",
    });

    return workspace.id;
  });
}
