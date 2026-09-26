import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { ensureDefaultWorkspace } from "@/lib/auth/actions";
import { createWorkflow } from "@/server/workflows/mutations";

export default async function NewWorkflowPage() {
  const user = await requireUser();
  const workspaceId = await ensureDefaultWorkspace(user.id, user.email ?? "usuário");

  const workflow = await createWorkflow(user.id, workspaceId, {
    name: "Untitled Workflow",
    description: "",
  });

  redirect(`/dashboard/workflows/${workflow.id}`);
}
