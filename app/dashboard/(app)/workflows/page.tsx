import Link from "next/link";
import { cn } from "@/lib/utils";
import { requireUser } from "@/lib/auth/session";
import { ensureDefaultWorkspace } from "@/lib/auth/actions";
import { listWorkflows } from "@/server/workflows/queries";
import { WorkflowsTable } from "./workflows-table";
import { buttonVariants } from "@/components/ui/button";

export default async function WorkflowsPage({
  searchParams,
}: {
  searchParams?: { archived?: string };
}) {
  const user = await requireUser();
  const workspaceId = await ensureDefaultWorkspace(user.id, user.email ?? "usuário");
  // Fase 10.5A: archived workflows live in their own view.
  const archived = searchParams?.archived === "true";
  const workflows = await listWorkflows(user.id, workspaceId, { archived });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{archived ? "Archived workflows" : "Workflows"}</h1>
        <div className="flex items-center gap-4">
          <Link
            href={archived ? "/dashboard/workflows" : "/dashboard/workflows?archived=true"}
            className="text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            {archived ? "Back to workflows" : "Archived"}
          </Link>
          {!archived && (
            <Link href="/dashboard/workflows/new" className={buttonVariants()}>
              + New workflow
            </Link>
          )}
        </div>
      </div>

      {workflows.length === 0 ? (
        archived ? (
          <div className="rounded-lg border border-border p-10 text-center">
            <p className="font-medium">No archived workflows</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Workflows that caused external effects are archived instead of deleted, so their history is kept.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-border p-10 text-center">
            <p className="font-medium">No workflows yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Create your first workflow to automate a process.
            </p>
            <Link href="/dashboard/workflows/new" className={cn(buttonVariants(), "mt-4")}>
              Create workflow
            </Link>
          </div>
        )
      ) : (
        // key: a fresh table per view, so local row state never crosses views.
        <WorkflowsTable key={archived ? "archived" : "active"} initialWorkflows={workflows} mode={archived ? "archived" : "active"} />
      )}
    </div>
  );
}
