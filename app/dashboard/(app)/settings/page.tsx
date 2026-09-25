import { requireUser } from "@/lib/auth/session";

export default async function SettingsPage() {
  const user = await requireUser();

  return (
    <div>
      <h1 className="text-2xl font-semibold">Configurações</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Logado como {user.email}.
      </p>
      {/*
        TODO (Fase 6): gerenciamento de membros do workspace, papéis
        (owner/admin/member/viewer) e credenciais. Não implementado ainda —
        nenhum botão abaixo deve ser adicionado até que a funcionalidade
        exista de fato, para não simular algo que não funciona.
      */}
    </div>
  );
}
