import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { ensureDefaultWorkspace } from "@/lib/auth/actions";
import { getWorkflowById } from "@/server/workflows/queries";
import { parseWorkflowDocument } from "@/lib/workflows/schema";
import { createEmptyWorkflowDocument } from "@/lib/workflows/types";
import { WorkflowEditor } from "@/components/workflow/editor/workflow-editor";

interface WorkflowPageProps {
  params: { workflowId: string };
}

export default async function WorkflowEditorPage({ params }: WorkflowPageProps) {
  const user = await requireUser();
  const workspaceId = await ensureDefaultWorkspace(user.id, user.email ?? "usuário");

  const workflow = await getWorkflowById(user.id, workspaceId, params.workflowId);
  if (!workflow) {
    notFound();
  }

  // Defensive: never hand an unvalidated document to the editor. If the
  // stored value somehow fails validation (manual DB edit, future schema
  // change without a migrator), fall back to an empty document rather than
  // crashing the page — the user can rebuild instead of being locked out.
  const parsedDocument = parseWorkflowDocument(workflow.document);
  const document = parsedDocument.success
    ? parsedDocument.data
    : createEmptyWorkflowDocument();

  return (
    <WorkflowEditor
      workflowId={workflow.id}
      initialName={workflow.name}
      initialStatus={workflow.status}
      initialDocument={document}
    />
  );
}
