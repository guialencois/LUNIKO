import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { ensureDefaultWorkspace } from "@/lib/auth/actions";
import { listWorkflows } from "@/server/workflows/queries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function DashboardPage() {
  const user = await requireUser();
  const workspaceId = await ensureDefaultWorkspace(user.id, user.email ?? "usuário");
  const workflows = await listWorkflows(user.id, workspaceId);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Visão geral</h1>
        <p className="text-sm text-muted-foreground">
          Workspace: <span className="font-mono">{workspaceId}</span>
        </p>
      </div>

      {/*
        TODO (Fase 4): Execuções e Taxa de sucesso dependem do workflow
        engine/execution history, que ainda não existem. O card de
        Workflows já reflete dados reais (Fase 2 implementa workflows CRUD).
      */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Link href="/dashboard/workflows">
          <Card className="transition-colors hover:bg-muted/50">
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Workflows
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">{workflows.length}</p>
            </CardContent>
          </Card>
        </Link>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Execuções
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">— (Fase 4)</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Taxa de sucesso
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">— (Fase 4)</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
