"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "inactive";
  updatedAt: Date;
  createdAt: Date;
  archivedAt?: Date | null;
}

function formatRelativeTime(date: Date): string {
  const seconds = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** apiError() shape: {error:{code,message}}. */
async function readApiError(response: Response): Promise<{ code: string; message: string }> {
  const body = (await response.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown } } | null;
  return {
    code: typeof body?.error?.code === "string" ? body.error.code : "REQUEST_FAILED",
    message:
      typeof body?.error?.message === "string" ? body.error.message : `Request failed with status ${response.status}`,
  };
}

/**
 * `mode` "archived" (Fase 10.5A) lists archived workflows with Restore.
 *
 * Deleting no longer fails silently: a workflow that caused external effects
 * cannot be deleted (their record is evidence) — the dialog says so and
 * offers Archive instead. Any other refusal is shown as the API wrote it.
 */
export function WorkflowsTable({
  initialWorkflows,
  mode = "active",
}: {
  initialWorkflows: WorkflowRow[];
  mode?: "active" | "archived";
}) {
  const [workflows, setWorkflows] = useState(initialWorkflows);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [dialogError, setDialogError] = useState<{ code: string; message: string } | null>(null);
  // Set once DELETE answered WORKFLOW_HAS_EFFECT_HISTORY: from then on the
  // dialog offers Archive, and stays that way even if archiving is refused.
  const [archiveOffer, setArchiveOffer] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const router = useRouter();

  function closeDialog() {
    setPendingDeleteId(null);
    setDialogError(null);
    setArchiveOffer(null);
  }

  async function handleDelete(id: string) {
    setIsBusy(true);
    try {
      const response = await fetch(`/api/workflows/${id}`, { method: "DELETE" });
      if (response.ok) {
        setWorkflows((prev) => prev.filter((w) => w.id !== id));
        closeDialog();
        router.refresh();
        return;
      }
      const error = await readApiError(response);
      if (error.code === "WORKFLOW_HAS_EFFECT_HISTORY" && mode === "active") {
        setArchiveOffer(error.message);
        setDialogError(null);
      } else if (error.code === "WORKFLOW_HAS_EFFECT_HISTORY") {
        // Already archived: nothing else to offer — its history is evidence.
        setDialogError({
          code: error.code,
          message:
            "This workflow caused external effects, so its history is kept as evidence and it cannot be deleted. It stays archived.",
        });
      } else {
        setDialogError(error);
      }
    } catch {
      setDialogError({ code: "NETWORK_ERROR", message: "Could not reach the server. Check your connection." });
    } finally {
      setIsBusy(false);
    }
  }

  async function handleArchive(id: string) {
    setIsBusy(true);
    try {
      const response = await fetch(`/api/workflows/${id}/archive`, { method: "POST" });
      if (response.ok) {
        setWorkflows((prev) => prev.filter((w) => w.id !== id));
        closeDialog();
        router.refresh();
        return;
      }
      setDialogError(await readApiError(response));
    } catch {
      setDialogError({ code: "NETWORK_ERROR", message: "Could not reach the server. Check your connection." });
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRestore(id: string) {
    setIsBusy(true);
    setRowError(null);
    try {
      const response = await fetch(`/api/workflows/${id}/restore`, { method: "POST" });
      if (response.ok) {
        setWorkflows((prev) => prev.filter((w) => w.id !== id));
        router.refresh();
        return;
      }
      setRowError({ id, message: (await readApiError(response)).message });
    } catch {
      setRowError({ id, message: "Could not reach the server. Check your connection." });
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
      {workflows.map((workflow) => (
        <div key={workflow.id} className="flex items-center justify-between p-4">
          <Link href={`/dashboard/workflows/${workflow.id}`} className="min-w-0 flex-1">
            <p className="truncate font-medium">{workflow.name}</p>
            <p className="text-sm text-muted-foreground">
              {mode === "archived" && workflow.archivedAt
                ? `Archived ${formatRelativeTime(workflow.archivedAt)}`
                : `Updated ${formatRelativeTime(workflow.updatedAt)}`}{" "}
              · <span className="capitalize">{workflow.status}</span>
            </p>
            {rowError?.id === workflow.id && <p className="text-sm text-destructive">{rowError.message}</p>}
          </Link>
          <div className="flex items-center gap-2">
            {mode === "archived" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => handleRestore(workflow.id)}
              >
                Restore
              </Button>
            ) : (
              <Link
                href={`/dashboard/workflows/${workflow.id}`}
                className="text-sm text-muted-foreground hover:text-foreground hover:underline"
              >
                Open
              </Link>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Delete ${workflow.name}`}
              onClick={() => {
                setDialogError(null);
                setArchiveOffer(null);
                setPendingDeleteId(workflow.id);
              }}
            >
              <Trash2 className="h-4 w-4 text-muted-foreground" />
            </Button>
          </div>
        </div>
      ))}

      {pendingDeleteId && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        >
          <div className="w-full max-w-sm rounded-lg border border-border bg-background p-5 shadow-lg">
            <p className="font-medium">{archiveOffer ? "Archive instead?" : "Delete workflow?"}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {archiveOffer ?? "This action cannot be undone."}
            </p>
            {dialogError && <p className="mt-2 text-sm text-destructive">{dialogError.message}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={closeDialog} disabled={isBusy}>
                Cancel
              </Button>
              {archiveOffer ? (
                mode === "active" && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => handleArchive(pendingDeleteId)}
                    disabled={isBusy}
                  >
                    {isBusy ? "Archiving..." : "Archive"}
                  </Button>
                )
              ) : (
                dialogError?.code !== "WORKFLOW_HAS_EFFECT_HISTORY" && (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDelete(pendingDeleteId)}
                    disabled={isBusy}
                  >
                    {isBusy ? "Deleting..." : "Delete"}
                  </Button>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
