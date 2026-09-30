# LUNIKO — plataforma de automação

Plataforma interna de automação visual, no estilo do n8n: o usuário monta um workflow
arrastando nós num canvas, e o sistema executa — de forma síncrona, ou por uma fila com
worker, lease e recuperação de falhas.

Next.js 14 (App Router) · TypeScript estrito · Tailwind · Supabase (Auth + Postgres) ·
Drizzle ORM · hospedado na Vercel.

## Estado atual

Medido em 29/09/2026 rodando os comandos, não estimado:

| Verificação | Resultado |
| --- | --- |
| `npm run typecheck` | 0 erros |
| `npm run lint` | sem avisos (cobre `app/`, `components/`, `lib/`, `server/`, `scripts/`) |
| `npm run build` | compila, 13 páginas |
| `npm test` sem banco de teste | 158 passam, 117 se autopulam |
| `npm test` com banco de teste | 271 passam, 4 estouram o tempo (ver abaixo) |
| Produção | no ar |

As 4 falhas **não são defeito de lógica** — nenhuma asserção falhou na suíte inteira. São
testes de integração que ultrapassam os 30s quando o banco de teste está numa região
distante. Detalhes em "Testes de integração".

### O que existe e funciona

Autenticação e workspaces com RLS. Editor visual de workflows (React Flow). Motor de
execução com registro de nós. Execução síncrona e assíncrona. Fila baseada em Postgres
(`FOR UPDATE SKIP LOCKED`) com claim atômico, lease, heartbeat e reaper de recuperação.
Protocolo de efeitos externos em três transações, com chave de idempotência e fencing por
época. Arquivamento de workflows. Contrato do adaptador Mercado Pago.

### O que ainda não existe

- **O agendador não está ligado.** `db/supabase/cron-jobs.sql` existe, mas não foi aplicado
  e a extensão `pg_cron` não está habilitada no projeto Supabase. Sem isso a fila nunca é
  consumida sozinha: execuções assíncronas ficam enfileiradas até alguém chamar o endpoint
  do worker à mão.
- **Triggers de webhook e de agenda** são stubs — ver
  `lib/execution/executors/triggers-not-implemented.ts`.
- **Credentials e criptografia.** `ENCRYPTION_KEY` é validada no carregamento do ambiente,
  mas ainda não é usada por nada. É intencional: evita reconfigurar tudo depois.
- **A chamada real ao Mercado Pago** (fase 10.5B-2). Só o contrato existe hoje.

## Pré-requisitos

- Node.js **24.x** (declarado em `engines`, e é a versão usada na Vercel e no CI)
- Um projeto no [Supabase](https://supabase.com)

## Configuração

1. Instale as dependências:

   ```bash
   npm ci
   ```

   `npm ci` e não `npm install`: instala exatamente o `package-lock.json` e falha se ele
   divergir do `package.json`.

2. Crie um `.env.local` na raiz com as variáveis abaixo.

3. Aplique as migrações:

   ```bash
   npm run db:migrate
   ```

   O script lê `DATABASE_URL` do ambiente e, se não achar, carrega o `.env.local` sozinho.

4. Suba o servidor:

   ```bash
   npm run dev
   ```

5. Abra `http://localhost:3000` — deve redirecionar para `/login`. Crie uma conta em
   `/register`, confirme o e-mail e você cai em `/dashboard` com um workspace criado.

## Variáveis de ambiente

`lib/env.ts` valida todas no carregamento do módulo. Faltando uma obrigatória, o `next build`
falha em `/api/health` — não é um erro misterioso, é a validação funcionando.

| Variável | Obrigatória | Onde obter |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | sim | a URL onde o app roda (`http://localhost:3000` em dev) |
| `NEXT_PUBLIC_SUPABASE_URL` | sim | Supabase → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | sim | mesma página, chave `anon` / `public` |
| `SUPABASE_SERVICE_ROLE_KEY` | sim | mesma página, chave `service_role` — **secreta** |
| `DATABASE_URL` | sim | Supabase → Connect → **Transaction pooler, porta 6543** |
| `ENCRYPTION_KEY` | sim | gere uma, mínimo 32 caracteres |
| `CRON_SECRET` | não | segredo compartilhado com o agendador, mínimo 32 caracteres |

Sobre a `CRON_SECRET`: os endpoints internos (`/api/internal/worker` e `/api/internal/reaper`)
**falham fechados**. Sem ela eles recusam toda requisição em vez de rodar sem autenticação.
Isso é seguro, mas tem uma consequência prática: **o app sobe normalmente e a execução
assíncrona simplesmente nunca acontece, sem erro visível.**

Sobre a `DATABASE_URL`: use o **transaction pooler (6543)** em produção —
`lib/db/index.ts` passa `prepare: false` exatamente por isso, porque esse modo não suporta
prepared statements. A conexão direta (`db.<ref>.supabase.co`) só responde em IPv6.

## Comandos

| Comando | O que faz |
| --- | --- |
| `npm run dev` | Servidor de desenvolvimento |
| `npm run build` | Build de produção |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Testes (integração se autopula sem `TEST_DATABASE_URL`) |
| `npm run db:generate` | Gera migração a partir do schema Drizzle |
| `npm run db:migrate` | Aplica as migrações pendentes de `db/migrations/` |
| `npm run db:studio` | Drizzle Studio |

## Testes de integração

`npm test` roda os 275 testes, mas os 117 de integração **se autopulam** quando
`TEST_DATABASE_URL` não está definida — é o que fazem os `describe.skipIf(!hasTestDb)`. Sem a
variável você vê `158 passed | 117 skipped`, e isso é o comportamento correto, não uma
regressão.

Para rodar os 275 é preciso um **banco Postgres separado**.

> **Nunca aponte `TEST_DATABASE_URL` para o banco de produção.** A suíte cria e apaga dados
> de verdade: workspaces, workflows, execuções e efeitos.

Preparação, uma vez só:

1. Crie um projeto Supabase novo **na mesma região da produção** (hoje `us-east-2`), ou suba
   um Postgres local. A latência domina o tempo da suíte: de uma região distante ela levou
   17 minutos e 4 testes estouraram os 30s; local, roda em cerca de um minuto.

2. Aplique o esquema nesse banco:

   ```bash
   DATABASE_URL="<string do banco de teste>" npm run db:migrate
   ```

   No PowerShell, em duas linhas: `$env:DATABASE_URL = "..."` e depois `npm run db:migrate`.

3. Rode a suíte completa:

   ```bash
   TEST_DATABASE_URL="<a mesma string>" npm test
   ```

Detalhes que já custaram tempo a quem veio antes:

- Os arquivos rodam **um por vez** (`fileParallelism: false`). Todos compartilham o mesmo
  banco, e o reaper de um arquivo varre as execuções de outro. Não é defeito do produto — é a
  suíte, escrita supondo um banco exclusivo, rodando contra um banco compartilhado.
- O `afterAll` **não consegue** apagar o workspace depois que existem `effect_operations`,
  por causa do `ON DELETE RESTRICT`. Sobra lixo no banco de teste a cada execução. Não afeta
  o resultado, mas acumula.
- Use o **session pooler (porta 5432)** para os testes, não o transaction pooler.

## Segurança

- Nenhuma secret (`SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `ENCRYPTION_KEY`,
  `CRON_SECRET`) usa o prefixo `NEXT_PUBLIC_`. Só o que tem esse prefixo vai para o
  JavaScript do navegador.
- RLS habilitada em todas as tabelas do schema `public`, inclusive na `_migrations`.
  `db/migrations/0008_rls_without_recursion.sql` usa a função `is_workspace_member`
  (SECURITY DEFINER) para evitar recursão nas políticas.
- `middleware.ts` bloqueia `/dashboard/*` para quem não está autenticado.
- `lib/auth/session.ts` centraliza a autorização (`requireWorkspaceMembership`). Nenhuma
  query a recurso de workspace deve pular essa checagem.
- `lib/workflows/redaction.ts` remove valores cujo nome de campo pareça credencial
  (`token`, `password`, `secret`, `key`, `authorization`, `cookie`, `credential`) antes de
  qualquer coisa ser gravada ou logada.
- Os endpoints internos exigem `Authorization: Bearer <CRON_SECRET>` e falham fechados.

## Integração contínua

`.github/workflows/ci.yml` roda `npm ci`, typecheck, lint, testes e build a cada Pull Request
e a cada push na `main`. Os testes de integração se autopulam lá, porque o CI não tem banco —
o que significa que **o CI cobre os 158 unitários, não os 275**. Rodar os 275 continua sendo
um passo manual antes de entregar.
