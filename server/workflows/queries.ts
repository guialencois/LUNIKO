import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { and, eq, desc, isNotNull, isNull } from "drizzle-orm";
import { requireWorkspaceMembership } from "@/lib/auth/session";

/**
 * Every function here takes (userId, workspaceId, ...) and calls
 * requireWorkspaceMembership before touching the workflows table. A
 * workspaceId coming from the client is never trusted on its own — see
 * item 36 (SEGURANÇA) of the product spec.
 */

/**
 * Active workflows by default. Archived ones (Fase 10.5A) are listed only
 * when asked for — they keep their history but are no longer part of the
 * working set.
 */
export async function listWorkflows(
  userId: string,
  workspaceId: string,
  options: { archived?: boolean } = {}
) {
  await requireWorkspaceMembership(userId, workspaceId);

  return db
    .select({
      id: workflows.id,
      name: workflows.name,
      description: workflows.description,
      status: workflows.status,
      updatedAt: workflows.updatedAt,
      createdAt: workflows.createdAt,
      archivedAt: workflows.archivedAt,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, workspaceId),
        options.archived ? isNotNull(workflows.archivedAt) : isNull(workflows.archivedAt)
      )
    )
    .orderBy(desc(workflows.updatedAt));
}

export async function getWorkflowById(
  userId: string,
  workspaceId: string,
  workflowId: string
) {
  await requireWorkspaceMembership(userId, workspaceId);

  const [workflow] = await db
    .select()
    .from(workflows)
    .where(
      and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId))
    )
    .limit(1);

  return workflow ?? null;
}
