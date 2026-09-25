# Automation Platform — Fase 1

Fundação do produto: Next.js + TypeScript + Tailwind + Supabase (Auth/Postgres) + Drizzle ORM.

**Escopo desta fase:** autenticação, workspace básico, proteção de rotas, dashboard inicial.
Nada de workflow editor, engine, filas, webhooks ou credentials ainda — isso vem nas fases seguintes,
com autorização explícita antes de cada uma.

## Pré-requisitos

- Node.js >= 18.18
- Uma conta/projeto no [Supabase](https://supabase.com)

## Configuração

1. Instale as dependências:

   ```bash
   npm install
   ```

2. Copie `.env.example` para `.env.local` e preencha os valores (instruções de onde
   encontrar cada um estão nos comentários do próprio arquivo):

   ```bash
   cp .env.example .env.local
   ```

3. Aplique a migration inicial (cria `workspaces` e `workspace_members`, com RLS):

   ```bash
   npm run db:migrate
   ```

4. Rode o servidor de desenvolvimento:

   ```bash
   npm run dev
   ```

5. Acesse `http://localhost:3000` — deve redirecionar para `/login`. Crie uma conta em
   `/register`, confirme o e-mail (Supabase envia o link), faça login e você deve cair em
   `/dashboard` com um workspace criado automaticamente.

## Comandos

| Comando              | O que faz                                              |
| --------------------- | ------------------------------------------------------- |
| `npm run dev`         | Servidor de desenvolvimento                              |
| `npm run build`       | Build de produção                                        |
| `npm run lint`        | ESLint                                                   |
| `npm run typecheck`   | `tsc --noEmit`                                           |
| `npm test`            | Testes unitários (Vitest)                                |
| `npm run db:generate` | Gera uma nova migration a partir do schema Drizzle       |
| `npm run db:migrate`  | Aplica migrations pendentes em `db/migrations/`          |
| `npm run db:studio`   | Abre o Drizzle Studio para inspecionar o banco           |

## Verificação (importante)

Este código foi escrito e revisado manualmente, mas **não pôde ser executado** no ambiente em
que foi gerado (sem acesso à internet para instalar as dependências do npm). Antes de considerar
a Fase 1 concluída, rode localmente e resolva o que aparecer:

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

Pontos que merecem atenção especial na primeira execução:
- Versões exatas de `@supabase/ssr`/`@supabase/supabase-js` podem ter pequenas mudanças de API;
  se o `typecheck` reclamar de `cookies()` ou dos tipos do `CookieOptions`, ajuste conforme a
  versão instalada.
- `ENCRYPTION_KEY` é validado no schema de env mesmo não sendo usado ainda nesta fase — isso é
  intencional (evita re-configurar tudo na Fase 6), mas exige um valor de pelo menos 32
  caracteres em `.env.local` já agora.

## Segurança já aplicada nesta fase

- Nenhuma secret (`SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `ENCRYPTION_KEY`) é exposta com
  prefixo `NEXT_PUBLIC_`.
- Row Level Security habilitada em `workspaces` e `workspace_members` (ver
  `db/migrations/0000_init.sql`): um usuário só vê workspaces dos quais é membro.
- `middleware.ts` bloqueia `/dashboard/*` para usuários não autenticados e redireciona usuários
  já autenticados para fora das páginas de login/registro.
- `lib/auth/session.ts` centraliza a checagem de autorização (`requireWorkspaceMembership`) —
  nenhuma query a recursos de um workspace deve pular essa checagem nas fases futuras.

## O que NÃO está implementado (de propósito)

Workflow editor (React Flow), workflow engine, Redis/filas, worker, webhooks, scheduler,
credentials/encryption, node registry. Ver o prompt mestre do produto para o roadmap completo
por fase.
