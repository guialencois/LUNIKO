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

  // `existing.length > 0` não estreita `existing[0]`: com
  // noUncheckedIndexedAccess o acesso por índice é sempre `T | undefined`.
  // Ler a linha numa constante e testá-la é o que o compilador entende, e
  // diz a mesma coisa.
  const membership = existing[0];
  if (membership) {
    return membership.workspaceId;
  }

  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: `Workspace de ${userEmail}` })
      .returning({ id: workspaces.id });

    // `returning()` devolve uma linha por linha inserida, então um INSERT de
    // uma única linha não devolver nada é impossível. Se acontecer, é falha
    // de infraestrutura e tem de aparecer com esse nome — não como um
    // TypeError em `workspace.id` duas linhas abaixo.
    if (!workspace) {
      throw new Error(
        "ensureDefaultWorkspace: o INSERT em workspaces não devolveu a linha criada"
      );
    }

    await tx.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId,
      role: "owner",
    });

    return workspace.id;
  });
}
