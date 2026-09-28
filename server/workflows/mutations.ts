import { db } from "@/lib/db";
import { workflows, executions, effectOperations } from "@/lib/db/schema";
import type { WorkflowRow } from "@/lib/db/schema";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { requireWorkspaceMembership } from "@/lib/auth/session";
import { createEmptyWorkflowDocument } from "@/lib/workflows/types";
import { pgErrorCode } from "@/lib/db/errors";
import { WorkflowConflictError, WORKFLOW_CONFLICT_MESSAGES } from "./errors";

export async function createWorkflow(
  userId: string,
  workspaceId: string,
  input: { name: string; description: string }
) {
  await requireWorkspaceMembership(userId, workspaceId);

  const [workflow] = await db
    .insert(workflows)
    .values({
      workspaceId,
      name: input.name,
      description: input.description,
      status: "draft",
      document: createEmptyWorkflowDocument(),
      createdBy: userId,
    })
    .returning();

  // Um INSERT de uma linha com RETURNING devolve exatamente uma linha: ou
  // insere e devolve, ou lança. Zero linhas aqui é falha de infraestrutura e
  // tem de aparecer com esse nome, em vez de propagar `undefined`.
  //
  // Isto NÃO é o mesmo caso das funções de UPDATE deste arquivo, que
  // devolvem `?? null` de propósito: lá o WHERE pode legitimamente não casar
  // (é o guard de cerca), e "nenhuma linha" é uma resposta, não um defeito.
  if (!workflow) {
    throw new Error("createWorkflow: o INSERT em workflows não devolveu a linha criada");
  }

  return workflow;
}

/**
 * Returns null when the workflow does not exist in this workspace (404), and
 * throws WorkflowConflictError("WORKFLOW_ARCHIVED") when it does but is
 * archived (409): an archived workflow is read-only until restored. The row
 * is locked first, so a concurrent archive cannot slip in between the check
 * and the write.
 */
export async function updateWorkflow(
  userId: string,
  workspaceId: string,
  workflowId: string,
  input: {
    name?: string;
    description?: string;
    status?: "draft" | "active" | "inactive";
    document?: unknown;
  }
) {
  await requireWorkspaceMembership(userId, workspaceId);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.status !== undefined) updates.status = input.status;
  if (input.document !== undefined) updates.document = input.document;

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: workflows.id, archivedAt: workflows.archivedAt })
      .from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId)))
      .limit(1)
      .for("update");
    if (!current) return null;
    if (current.archivedAt) {
      throw new WorkflowConflictError("WORKFLOW_ARCHIVED", WORKFLOW_CONFLICT_MESSAGES.WORKFLOW_ARCHIVED);
    }

    const [workflow] = await tx
      .update(workflows)
      .set(updates)
      .where(
        and(
          eq(workflows.id, workflowId),
          eq(workflows.workspaceId, workspaceId),
          isNull(workflows.archivedAt)
        )
      )
      .returning();

    return workflow ?? null;
  });
}

/**
 * Hard delete — only for a workflow that never caused an external effect.
 *
 * Deleting a workflow cascades to its executions, and effect_operations
 * references executions with ON DELETE RESTRICT (0006): the record of a
 * message sent or a charge created is evidence, and never disappears as a
 * side effect of deleting something else. So a workflow with that history
 * throws WorkflowConflictError("WORKFLOW_HAS_EFFECT_HISTORY") — archive it
 * instead. Checked explicitly (a clear 409, not a 500 from the foreign key),
 * with the foreign key as the backstop for the race where a running
 * execution records its first effect between the check and the delete.
 *
 * Returns null when not found, as before.
 */
export async function deleteWorkflow(
  userId: string,
  workspaceId: string,
  workflowId: string
) {
  await requireWorkspaceMembership(userId, workspaceId);

  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId)))
        .limit(1)
        .for("update");
      if (!current) return null;

      const [withEffect] = await tx
        .select({ id: effectOperations.id })
        .from(effectOperations)
        .innerJoin(executions, eq(executions.id, effectOperations.executionId))
        .where(eq(executions.workflowId, workflowId))
        .limit(1);
      if (withEffect) {
        throw new WorkflowConflictError(
          "WORKFLOW_HAS_EFFECT_HISTORY",
          WORKFLOW_CONFLICT_MESSAGES.WORKFLOW_HAS_EFFECT_HISTORY
        );
      }

      const [deleted] = await tx
        .delete(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId)))
        .returning({ id: workflows.id });

      return deleted ?? null;
    });
  } catch (err) {
    if (pgErrorCode(err) === "23503") {
      throw new WorkflowConflictError(
        "WORKFLOW_HAS_EFFECT_HISTORY",
        WORKFLOW_CONFLICT_MESSAGES.WORKFLOW_HAS_EFFECT_HISTORY
      );
    }
    throw err;
  }
}

export type ArchiveWorkflowResult =
  | { outcome: "archived"; workflow: WorkflowRow }
  | { outcome: "already_archived"; workflow: WorkflowRow }
  | { outcome: "not_found" };

/**
 * Archive: the workflow leaves the working set, keeps every execution and
 * every record of external effects, receives no new executions, and is
 * read-only until restored. Refused while it has queued or running WORKER
 * executions — nothing may keep acting on behalf of an archived workflow.
 * Synchronous executions do not count: they cannot cause external effects
 * (EXTERNAL_EFFECTS_UNAVAILABLE), and one left "running" by a request that
 * died is never recovered (by design) — counting it would make the workflow
 * impossible to archive, forever.
 *
 * Race-free by construction, not by timing: this locks the workflow row
 * (FOR UPDATE), and inserting an execution reads it FOR SHARE (trigger in
 * 0007). Either the execution exists before the check below looks, or it is
 * refused once the archive commits. The trigger on workflows (WK002) is the
 * backstop for any other writer.
 *
 * Idempotent: archiving an archived workflow reports already_archived.
 */
export async function archiveWorkflow(
  userId: string,
  workspaceId: string,
  workflowId: string
): Promise<ArchiveWorkflowResult> {
  await requireWorkspaceMembership(userId, workspaceId);

  try {
    return await db.transaction(async (tx): Promise<ArchiveWorkflowResult> => {
      const [current] = await tx
        .select()
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId)))
        .limit(1)
        .for("update");
      if (!current) return { outcome: "not_found" };
      if (current.archivedAt) return { outcome: "already_archived", workflow: current };

      const [active] = await tx
        .select({ id: executions.id })
        .from(executions)
        .where(
          and(
            eq(executions.workflowId, workflowId),
            eq(executions.runner, "worker"),
            inArray(executions.status, ["queued", "running"])
          )
        )
        .limit(1);
      if (active) {
        throw new WorkflowConflictError(
          "WORKFLOW_HAS_ACTIVE_EXECUTIONS",
          WORKFLOW_CONFLICT_MESSAGES.WORKFLOW_HAS_ACTIVE_EXECUTIONS
        );
      }

      const now = new Date();
      const [archived] = await tx
        .update(workflows)
        .set({ archivedAt: now, archivedBy: userId, updatedAt: now })
        .where(and(eq(workflows.id, workflowId), isNull(workflows.archivedAt)))
        .returning();
      if (!archived) return { outcome: "not_found" }; // cannot happen under the row lock
      return { outcome: "archived", workflow: archived };
    });
  } catch (err) {
    if (pgErrorCode(err) === "WK002") {
      throw new WorkflowConflictError(
        "WORKFLOW_HAS_ACTIVE_EXECUTIONS",
        WORKFLOW_CONFLICT_MESSAGES.WORKFLOW_HAS_ACTIVE_EXECUTIONS
      );
    }
    throw err;
  }
}

export type RestoreWorkflowResult =
  | { outcome: "restored"; workflow: WorkflowRow }
  | { outcome: "not_archived"; workflow: WorkflowRow }
  | { outcome: "not_found" };

/**
 * Restore: back to the working set, exactly as it was — `status` is not
 * touched by archive or restore.
 */
export async function restoreWorkflow(
  userId: string,
  workspaceId: string,
  workflowId: string
): Promise<RestoreWorkflowResult> {
  await requireWorkspaceMembership(userId, workspaceId);

  return db.transaction(async (tx): Promise<RestoreWorkflowResult> => {
    const [current] = await tx
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId)))
      .limit(1)
      .for("update");
    if (!current) return { outcome: "not_found" };
    if (!current.archivedAt) return { outcome: "not_archived", workflow: current };

    const [restored] = await tx
      .update(workflows)
      .set({ archivedAt: null, archivedBy: null, updatedAt: new Date() })
      .where(and(eq(workflows.id, workflowId), isNotNull(workflows.archivedAt)))
      .returning();
    if (!restored) return { outcome: "not_found" }; // cannot happen under the row lock
    return { outcome: "restored", workflow: restored };
  });
}
