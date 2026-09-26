# HANDOFF — Automation Platform (plataforma de automação estilo n8n)

Este documento existe para outra IA (ou outro humano) continuar exatamente
de onde este trabalho parou, sem precisar reconstruir o histórico de
decisões. Leia isto antes de tocar em qualquer código.

## Regra mais importante deste projeto

**Nunca afirme que um comando (`npm install`, `lint`, `typecheck`, `test`,
`build`) passou sem executá-lo de verdade.** O ambiente onde este projeto
foi construído até agora não tinha acesso à internet (`npm install` falha
com `403 host_not_allowed`), então **nada foi instalado e nenhum teste
rodou de fato**. Tudo que existe foi revisado manualmente e passou por um
check sintático (`tsc` sem `node_modules`, só gramática) — isso não é
validação de tipos real, nem prova que o código funciona em runtime. Se
você tem acesso a um ambiente com internet, a primeira coisa a fazer é:

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

e corrigir o que aparecer — é esperado que apareça algo (a versão exata de
`@supabase/ssr`/`@xyflow/react`/`drizzle-kit` etc. pode ter mudado desde
que as versões no `package.json` foram escolhidas de memória, sem consultar
o registry).

Para testes que dependem de um banco real (a maioria dos testes de
`server/execution/*` e `server/workflows/*`), defina `TEST_DATABASE_URL`
apontando para um Postgres com as migrations aplicadas
(`npm run db:migrate`).

## O que é este projeto

Uma plataforma de automação de workflows (tipo n8n), sendo construída em
fases, com um prompt mestre original completo (não incluído neste pacote,
mas cujas decisões estão refletidas no código e nos comentários). Stack:
Next.js 14 (App Router) + TypeScript strict + Tailwind + Supabase
(Auth + Postgres) + Drizzle ORM + React Flow (`@xyflow/react`) + Zustand.

## Estado por fase

### Fase 1 — Fundação: CONCLUÍDA (não validada em runtime)
Auth (Supabase), `workspaces`/`workspace_members`, middleware de proteção
de rotas, dashboard básico. Ver `README.md`.

### Fase 2 — Editor visual de workflows: CONCLUÍDA (não validada em runtime)
`WorkflowDocument`/`WorkflowNode`/`WorkflowEdge` (`lib/workflows/types.ts`),
Node Registry com 11 nodes (`lib/workflows/registry.ts` +
`lib/workflows/definitions/*.ts`), schema Zod com validação estrutural
completa incluindo handles (`lib/workflows/schema.ts`), CRUD de workflows
(`server/workflows/*`, `app/api/workflows/*`), editor React Flow completo
(`components/workflow/editor/*`, `components/workflow/nodes/*`). Ver
`docs/workflow-editor.md` e `docs/adding-nodes.md`.

### Fase 3 — Workflow Engine síncrono: CONCLUÍDA (não validada em runtime)
`lib/execution/{types,graph,planner,executor,errors,result,context,data}.ts`
+ `lib/execution/executors/*.ts` (um executor por tipo de node — só
`manualTrigger`/`set`/`transform`/`if`/`switch`/`merge`/`delay` executam de
verdade; `httpRequest`/`code`/`webhookTrigger`/`scheduleTrigger` são
`NOT_IMPLEMENTED` de propósito — nunca "fingem" funcionar). Persistência em
`server/execution/execution-repository.ts` (funções `createExecution`,
`finishExecution`, `insertExecutionNodes`, `getExecutionById` — usadas pelo
caminho síncrono). Orquestração em
`server/execution/execute-workflow.ts` (`executeWorkflow()`). API:
`POST /api/workflows/[id]/execute`. UI: botão Execute +
painel de resultado no editor (`components/workflow/editor/execution-*`).
Tabelas `executions`/`execution_nodes` (`lib/db/schema/executions.ts`,
migrations `0002_executions.sql`). Ver `docs/node-executors.md` (se
existir — checar `docs/`) para limitações de cada executor.

**Importante:** o engine síncrono nunca foi alterado durante a Fase 4 — ele
continua funcionando exatamente como terminou na Fase 3, sem nenhuma
dependência da fila/worker/reaper que vieram depois.

### Fase 4 — Execução assíncrona: EM ANDAMENTO

Arquitetura completa fechada em **`docs/async-execution.md`** — leia esse
arquivo inteiro antes de continuar qualquer coisa da Fase 4. Ele documenta:
os dois modelos de autorização (Modelo 1 = usuário vivo, revalida
membership; Modelo 2 = worker interno, só `executionId` como credencial,
nunca recebe `workspaceId` de fora do banco), o lifecycle
`queued→running→success|error|cancelled`, idempotência, retry, cancelamento
(mecanismo ainda não construído), timeout (duas camadas: engine + job), a
decisão de usar **Postgres como fila** (não Redis/BullMQ, com justificativa
completa) e o contrato planejado de `GET /api/executions/[executionId]`
(ainda não implementado).

Sub-fases concluídas (código escrito, **nunca executado**):

- **4C — Lifecycle/persistência:** colunas `result`/`claimAttempts` em
  `executions` (migration `0003_execution_lifecycle.sql`). Funções novas em
  `server/execution/execution-repository.ts`: `createQueuedExecution`,
  `claimQueuedExecution`, `reclaimExpiredExecution`,
  `findStaleRunningExecutionIds`, `abandonExecution`,
  `finishQueuedExecution`, `insertExecutionNodesInternal`.
- **4D — Fila baseada em Postgres:** `server/execution/execution-queue.ts`
  — `enqueueExecution(executionId)` (valida, não insere nada) e
  `claimNextQueuedExecution()` (`SELECT ... FOR UPDATE SKIP LOCKED` dentro
  de transação — **atenção:** usa `.for("update", { skipLocked: true })`
  do Drizzle ORM, API nunca confirmada contra o pacote real instalado).
- **4E — Worker processor:** `server/execution/process-queued-execution.ts`
  — `processQueuedExecution(executionId, options?)`. Reusa
  `claimQueuedExecution` (4C), o planner/engine da Fase 3 sem alteração,
  `insertExecutionNodesInternal`/`finishQueuedExecution` (4C). Nunca cria
  um segundo lock.
- **4F — Recovery/reaper:** `server/execution/recovery-reaper.ts` —
  `recoverStaleExecutions()`. Durante esta etapa encontrei e corrigi uma
  inconsistência real em `abandonExecution` (não checava staleness/limite
  de tentativas no `WHERE`, só `status='running'` — corrigido para exigir
  as duas condições atomicamente, igual `reclaimExpiredExecution`).
  Adicionei o código de erro `WORKER_CRASHED` a
  `lib/execution/errors.ts` (não existia, só era mencionado em texto).

## Ponto em aberto mais importante — RESOLVIDO (auditoria seguinte)

**`finishQueuedExecution` não tinha nenhuma condição de status no `WHERE`.**
A etapa anterior encontrou isso e deliberadamente não corrigiu, por
considerar que era decisão de produto. A auditoria seguinte reproduziu o
comportamento contra um PostgreSQL real e corrigiu — com o registro da
decisão aqui, porque a pergunta original continua válida em parte.

O que foi reproduzido, em Postgres de verdade (não revisão estática):

1. worker trava → reaper abandona (`error` / `WORKER_CRASHED`) → worker
   acorda e chama `finish` → a linha terminal vira `success`. O veredito
   do reaper era revertido, e o usuário via sucesso numa execução que o
   sistema já tinha dado como falha;
2. finalizar era repetível sem limite — qualquer chamada posterior
   substituía um status já final.

**Decisão tomada: o worker atrasado perde.** O `WHERE` agora exige
`status = 'running' AND claim_attempts = <época do claim>`, usando
`claimAttempts` como *fencing token* — todo caminho de claim já o
incrementa, então ele é uma época monotônica de posse, sem coluna nova.
Só o guard de status não bastaria: depois de um reclaim a linha volta a
`running`, e apenas a época distingue o dono antigo do novo.

Razão de não ser simétrico ("quem chegar por último ganha"): um `finish`
tardio pode chegar arbitrariamente tarde, e enquanto ele puder sobrescrever
estado terminal **nenhum design de retry é seguro** — no momento em que um
reclaim de fato reexecutar o workflow, dois workers poderiam finalizar a
mesma execução. O fencing é pré-requisito para a decisão 1 de
`docs/async-execution.md`, não uma alternativa a ela.

`finishQueuedExecution` retornando `null` passa a significar "você não é
mais o dono". O processor trata como `skipped` / `lease_lost`, descarta o
próprio resultado e não reescreve nada.

**O que ainda é decisão de produto, e não foi decidido aqui:** se um
resultado tardio-porém-correto deve ser *aproveitado* de alguma forma
(guardado à parte, ou autorizado a superar um `WORKER_CRASHED` dentro de
alguma janela), em vez de simplesmente descartado. Hoje é descartado, e só
fica no log (`lease_lost`).

Validação: `scripts/f4f-lifecycle-harness.sql` (13 cenários, todos PASS
contra PostgreSQL 16). Os testes equivalentes em TypeScript estão em
`process-queued-execution.integration.test.ts` e continuam sem rodar
enquanto `node_modules` não for instalável.

As outras duas coisas encontradas na mesma auditoria também foram fechadas
(Fase 4G) — ver `docs/async-execution.md`, seção "Auditoria F4F":

- **reclaim agora devolve para `queued`**, o estado que o worker de fato
  consome, então um worker morto vira retomada e não falha atrasada. O
  reclaim não gasta tentativa; quem gasta é o próximo claim.
- **execução síncrona saiu do circuito de recuperação** por uma coluna
  explícita `runner` (`request` | `worker`, migration 0004), com o banco
  recusando uma execução de request na fila. `finishExecution` também
  passou a exigir `runner='request' AND status='running'`, fechando o
  caminho inverso.
- `insertExecutionNodesInternal` agora é fenced pela época e substitui a
  tentativa anterior, em vez de acumular dois runs no histórico.

Validação: `scripts/f4f-lifecycle-harness.sql` e
`scripts/concurrency-check.sh` (este último abre sessões psql em paralelo,
que é o único jeito de exercitar o `FOR UPDATE SKIP LOCKED`).

## O que ainda NÃO existe (Fase 4)

- ~~Loop do worker~~ — **existe** desde a Fase 4I, como invocação limitada
  disparada por Supabase Cron (`POST /api/internal/worker`), não como
  processo persistente. Ver "Fase 4I" em `docs/async-execution.md`.
- ~~Chamada periódica do reaper~~ — **existe**: `POST /api/internal/reaper`,
  agendado pelo Supabase Cron a cada 30s (`db/supabase/cron-jobs.sql`).
- ~~`GET /api/executions/[executionId]`~~ — **criado** na Fase 4I, com
  allowlist explícita (sem `runner`, sem `claimAttempts`, sem documento).
- Exposição do modo assíncrono na UI. A infraestrutura de cliente existe
  (`executeAsync()` no `execution-store`, com polling limitado), mas nenhum
  controle a aciona: o botão continua síncrono e o padrão da API continua
  `mode:"sync"`. Falta decidir como o modo é escolhido, e uma página de
  histórico de execuções.

- ~~Heartbeat/lease~~ — **implementado** na Fase 9 (`lease_expires_at`,
  migration 0005). O reaper decide por lease vencido, não mais por
  `started_at` velho. A renovação carrega a mesma época do fencing, então
  worker superado não renova, não grava nós e não finaliza.

- ~~Idempotência de efeitos externos~~ — **infraestrutura existe** desde a
  Fase 10 (abaixo), provada só com provedor falso. Nenhuma integração real.
- Cancelamento externo (coluna no banco + endpoint).
- Redis/BullMQ — decisão foi não usar, ao menos por enquanto (ver doc).
- Qualquer executor com efeito colateral real (HTTP, IA, WhatsApp, Google
  Ads). Continua **bloqueado**: a Fase 10 entregou o registro de operações
  externas, mas faltam credenciais cifradas (Fase 11) e os pré-requisitos
  listados na Fase 10 abaixo.

## Fase 10 — registro durável de operações externas: CONCLUÍDA (sem integração real)

Leia "Fase 10" em `docs/async-execution.md` antes de escrever o primeiro
executor que fale com o mundo lá fora. Em uma frase: todo efeito externo
passa por `context.effects.run(nodeId, spec)`, que reserva a operação,
cruza o ponto sem volta UMA vez (commitado antes da chamada), chama sem
transação aberta, e grava a resposta como fato.

- Tabelas `effect_operations` (uma linha por operação lógica) e
  `effect_attempts` (histórico append-only), migration
  `0006_effect_operations.sql`. `RESTRICT`, nunca `CASCADE`.
- Chave = sha256 de `["v1", executionId, nodeId, businessKey, operation]`.
  `businessKey` obrigatória, nunca índice de item. Sem época na chave.
- Estados `reserved → in_flight → succeeded | failed | unknown`. `unknown`
  é permanente até resolução explícita (ou fato do provedor relatado pela
  época que fez a chamada). Nunca vira `failed` ou retry sozinho. Resolução
  humana é juízo: um fato do provedor que chegue depois a substitui.
- Só `at_most_once`. O banco recusa qualquer outra política — e, por
  trigger, qualquer transição fora da máquina de estados (`began_epoch`
  gravado uma vez, nada volta para `reserved`).
- Decisões cercadas por POSSE da execução (`FOR SHARE`); fatos por AUTORIA
  (mesma execução + `began_epoch`). Execução que termina (de qualquer estado)
  com operação em voo: trigger converte para `unknown` no mesmo commit.
- Texto de exceção nunca é gravado; cada chamada tem prazo de 20s (resposta
  tardia ainda é gravada como fato).
- `context.epoch` e `context.effects` só existem no caminho assíncrono. O
  síncrono falha com `EXTERNAL_EFFECTS_UNAVAILABLE`.
- Provedor falso e executor modelo: `server/execution/effects/test-support/`
  — **nunca** registrados no registry de produção.

**Pré-requisitos antes da primeira integração real (Fase 12+):**
1. Fase 11 — credenciais cifradas (não misturar com isto).
2. ~~Rota/UI para listar e resolver operações `unknown`~~ — **API feita na
   Fase 10.5A** (abaixo); a UI de efeitos ainda não existe.
3. ~~Decidir retenção vs. exclusão~~ — **decidido na 10.5A**: workflow com
   histórico de efeito é arquivado, não apagado.
4. Adaptador segue o contrato do doc: `failed` só para recusa definitiva,
   todo o resto `unknown`; referência e mensagens não secretas.

Validação (executada): 128 PASS na spec Node dos módulos reais (20
mutações, todas detectadas); 76 PASS na seção 8 do harness contra
PostgreSQL 16 (seções 1–7 seguem 56 PASS); 23 PASS em
`concurrency-check.sh`, incluindo o teste C com duas sessões reais. Uma
revisão independente (outro agente) achou 3 problemas médios e 7 menores —
todos corrigidos, com teste. Vitest: escrito, **não executado** (npm 403).

## Fase 10.5A — arquivar; resolver `unknown` com evidência: CONCLUÍDA (sem integração real)

Leia "Fase 10.5A" em `docs/async-execution.md`. Em uma frase: uma pessoa
(owner/admin) resolve um `unknown` só com evidência do provedor e
justificativa, só depois que a execução terminou e passou o resfriamento
(600 s desde o `began`, relógio do banco), uma vez; e a resposta do provedor
que chegar depois substitui a decisão. Workflow com histórico de efeito é
arquivado, não apagado.

- Migration `0007_workflow_archive_and_effect_resolution.sql`:
  `workflows.archived_at/archived_by`; triggers WK001 (arquivado não recebe
  execução) e WK002 (não arquiva com execução do WORKER viva);
  `effect_operations.resolution`; CHECKs de evidência e de coerência
  (NOT VALID: valem daqui em diante); guard redefinido (pessoa não
  sobrescreve pessoa); e os dois triggers do item 6 (WK003): a decisão de
  uma pessoa e o fato `resolved` que a registra são inseparáveis, nas duas
  direções, para qualquer escritor.
- Contrato: `server/execution/effects/resolution.ts` (zod). View pública:
  `effect-view.ts` (allowlist). Repositório: `resolveUnknownEffectOperation`,
  `listEffectOperations`, `getEffectOperationDetail`.
- Rotas: `GET /api/effects`, `GET /api/effects/[operationId]`,
  `POST /api/effects/[operationId]/resolve`,
  `POST /api/workflows/[id]/archive`, `POST /api/workflows/[id]/restore`,
  `GET /api/workflows?archived=true`; DELETE com histórico → 409
  `WORKFLOW_HAS_EFFECT_HISTORY`; Execute/PATCH em arquivado → 409
  `WORKFLOW_ARCHIVED`.
- UI: aba "Archived" com Restore; o diálogo de apagar oferece Arquivar. Sem
  UI de efeitos.
- Fora de propósito: retry, maker-checker, corrigir resolução, Mercado Pago.
- Texto livre da resolução recusa credencial/header colado
  (`LOOKS_LIKE_CREDENTIAL`) — o fato `resolved` é append-only.
- Dois débitos pré-existentes, corrigidos DEPOIS da 10.5A, como
  infraestrutura (ver "Dois débitos de infraestrutura" no doc): o executar
  passou para `app/api/workflows/[id]/execute` (slugs irmãos com nomes
  diferentes quebram o build do Next; a URL não mudou), e a migration
  `0008_rls_without_recursion.sql` acabou com a recursão das policies de RLS
  da 0000 (função `public.is_workspace_member`, SECURITY DEFINER).

Validação (executada): harness 219 PASS (seções 1–7: 56; 8: 79; 9: 78;
10 (RLS da 0008): 6) em PostgreSQL 16 limpo; `concurrency-check.sh` 37 PASS
(14 novos: arquivar × executar nas duas ordens, duas pessoas resolvendo,
resolução × resposta tardia); 14/14 controles negativos de banco acusados;
spec Node 182 PASS com 41/41 mutações; rotas reais 42 PASS com 16/16
mutações (inclui o executar, movido para `[id]`); modelo de tipos 0
erros (13/13 erros plantados acusados). Uma revisão independente (outro
agente) achou 4 problemas reais (validador caro com corpo grande; a CHECK de
evidência passando com chave ausente — `NULL IN (...)` é NULL; nada amarrando
as colunas de resolução ao histórico; execução síncrona zumbi travando o
arquivamento) e 3 menores — **todos corrigidos**, com teste e controle
negativo. Vitest: escrito, **não executado** (npm 403).

## Testes existentes (todos escritos, nenhum executado)

Testes unitários puros (não precisam de banco):
`lib/workflows/*.test.ts`, `lib/execution/*.test.ts`,
`lib/execution/executors/*.test.ts`,
`components/workflow/editor/execution-*.test.ts(x)` (estes de UI precisam
de `@testing-library/react`+`jsdom`, adicionados ao `package.json` como
devDependency mas nunca instalados).

Testes de integração (precisam de `TEST_DATABASE_URL`):
`server/workflows/*.integration.test.ts`,
`server/execution/*.integration.test.ts`,
`server/execution/effects/effect-runner.integration.test.ts`,
`server/execution/effects/effect-resolution.integration.test.ts` e
`server/workflows/workflow-archive.integration.test.ts` (10.5A) — inclui
especificamente testes de concorrência real (dois claims simultâneos, dois
reapers simultâneos) que só fazem sentido contra um Postgres de verdade,
não contra mock. O de efeitos limpa `effect_attempts` e `effect_operations`
antes do workspace (RESTRICT).

Validação que DE FATO roda neste ambiente, sem `node_modules`:
`scripts/f4f-lifecycle-harness.sql` (psql, 10 seções — a 10 roda como papel
comum, para exercitar RLS),
`scripts/concurrency-check.sh` (sessões psql paralelas, cenários 1–9) e
`scripts/effects-spec/run.sh --types --mutate --routes --routes-mutate`
(módulos reais de efeitos, o contrato de resolução com zod e as rotas reais,
compilados e executados em Node, com mutações; precisa de `TYPES_ROOT` e
`ZOD_ROOT` sem `node_modules`). Ver o cabeçalho de cada um.
`scripts/effects-spec` está no `exclude` do `tsconfig.json` de propósito.

## Convenções a preservar

- **Nunca** `eval`/`new Function`/`vm.*` em lugar nenhum — nem para o node
  `Code` (que é `NOT_IMPLEMENTED` de propósito).
- **Nunca** confiar em `workspaceId` vindo do cliente ou de um payload de
  fila — sempre derivado server-side (`ensureDefaultWorkspace` para
  usuário vivo; lido da própria linha do banco para o worker).
- Todo node novo: criar em `lib/workflows/definitions/`, registrar em
  `lib/workflows/definitions/index.ts`, e se for executável, criar em
  `lib/execution/executors/` e registrar em
  `lib/execution/executors/index.ts` — são dois registries separados de
  propósito (definição vs. execução). Ver `docs/adding-nodes.md`.
- RLS existe nas tabelas mas não é o que protege escritas (a API conecta
  direto via `DATABASE_URL`, sem passar por RLS) — autorização real é
  sempre em código (`requireWorkspaceMembership`), documentado em vários
  comentários espalhados pelo repository.
- Toda migration é incremental (`000N_*.sql`), nunca reescreve uma anterior.
