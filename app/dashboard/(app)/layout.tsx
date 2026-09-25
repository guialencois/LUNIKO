import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { signOutAction } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r border-border p-4">
        <div className="mb-6 text-lg font-semibold">Automation Platform</div>
        <nav className="flex flex-col gap-2 text-sm">
          <Link href="/dashboard" className="rounded-md px-2 py-1.5 hover:bg-muted">
            Visão geral
          </Link>
          <Link
            href="/dashboard/workflows"
            className="rounded-md px-2 py-1.5 hover:bg-muted"
          >
            Workflows
          </Link>
          <Link
            href="/dashboard/settings"
            className="rounded-md px-2 py-1.5 hover:bg-muted"
          >
            Configurações
          </Link>
        </nav>
      </aside>
      <main className="flex-1">
        <header className="flex items-center justify-between border-b border-border px-6 py-3">
          <span className="text-sm text-muted-foreground">{user.email}</span>
          <form action={signOutAction}>
            <Button type="submit" variant="outline" size="sm">
              Sair
            </Button>
          </form>
        </header>
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
