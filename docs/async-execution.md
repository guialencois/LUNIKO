# Execução Assíncrona — Fundação (Fase 4)

Este documento descreve a arquitetura alvo para migrar de execução síncrona
(API bloqueada até o workflow terminar) para assíncrona (API enfileira,
worker processa). **Nada neste documento está implementado ainda** — é
especificação, para revisão, antes de qualquer código.

A interface `Queue` abaixo é o contrato mínimo; a seção "Fila — decisão
conceitual" fecha qual caminho seguimos (sem instalar nada ainda).

## Estado atual (Fase 3, inalterado)

```
Usuário → API (route.ts) → executeWorkflow() → engine síncrono → banco
```

`executeWorkflow()` (`server/execution/execute-workflow.ts`) hoje faz tudo
numa chamada só: carrega o workflow, tira o snapshot do document, cria a
`execution` (`createExecution`), roda `buildExecutionPlan` +
`runExecutionPlan` (`lib/execution/{planner,executor}.ts` — **o engine em
si, que este documento não toca**), grava `execution_nodes`
(`insertExecutionNodes`) e finaliza a `execution` (`finishExecution`), tudo
antes de responder ao HTTP request.

## Arquitetura alvo

```
Usuário
  ↓
API (route.ts)
  ↓ auth + workspace + validação (inalterado)
enqueueWorkflowExecution()
  ↓ cria a execution (status "queued") + tira o snapshot do document
Queue.enqueue({ executionId })
  ↓
  ... resposta HTTP volta aqui, imediatamente (202, não 200) ...

Worker (processo separado)
  ↓
Queue.consume(handler)
  ↓
processQueuedExecution(executionId)
  ↓ claim atômico (queued → running)
  ↓ carrega a execution (já tem o snapshot do document)
buildExecutionPlan() + runExecutionPlan()   ← engine inalterado, mesmo código de hoje
  ↓
insertExecutionNodes() + finishExecution()   ← repository inalterado, mesmo código de hoje
```

## Responsabilidades por camada

### 1. O que continua em `executeWorkflow()` / no engine

**Nada muda no engine** (`lib/execution/{types,graph,planner,executor,errors,result}.ts`
e `lib/execution/executors/*`). `buildExecutionPlan` e `runExecutionPlan`
continuam puras funções síncronas que recebem um `WorkflowDocument` (ou seu
snapshot) e devolvem um resultado — elas não sabem e não precisam saber se
foram chamadas de dentro de uma request HTTP ou de dentro de um worker. Essa
é a razão de terem sido desenhadas assim desde a Fase 3 (item 36 do prompt
original: "não misturar workflow engine com estado do editor" — o mesmo
princípio agora paga dividendo para não misturar engine com transporte).

`executeWorkflow()` em si **deixa de existir como uma função única** — vira
duas:

- **`enqueueWorkflowExecution(input)`** — o que a API chama. Faz a parte
  síncrona e rápida: autoriza, carrega o workflow, valida, tira o snapshot,
  chama `createExecution` (inalterado) e `Queue.enqueue(...)`. Retorna
  `{executionId, status: "queued"}` imediatamente — **não** roda o engine.
- **`processQueuedExecution(executionId)`** — o que o worker chama. Carrega
  a `execution` já criada (via `getExecutionById`, inalterado), faz o claim
  atômico (ver "Idempotência" abaixo), roda `buildExecutionPlan` +
  `runExecutionPlan` a partir do **snapshot já persistido** (nunca busca o
  `workflows.document` de novo — ver "Snapshot" abaixo), e chama
  `insertExecutionNodes`/`finishExecution` (inalterados).

`server/execution/execution-repository.ts` **não muda nenhuma função
existente** — `createExecution`, `finishExecution`, `insertExecutionNodes`,
`getExecutionById` continuam exatamente como estão. A única adição
necessária (não feita ainda) é uma função de claim atômico, descrita
abaixo.

### 2. O que pertence à API

- Autenticação, derivação de `workspaceId` a partir do usuário, validação
  Zod do body — **tudo isso já existe em `route.ts` e não muda**.
- Chamar `enqueueWorkflowExecution` em vez de `executeWorkflow`.
- Responder **imediatamente** com `{executionId, status:"queued"}`.
- **Mudança de contrato HTTP:** hoje a rota responde `200` com o resultado
  final. No modelo assíncrono, ela precisa responder algo como `202
  Accepted` com só o `executionId` — o resultado final não existe ainda no
  momento da resposta. Isso é uma mudança real de contrato para quem chama
  a API (a UI atual, por exemplo, espera o resultado na mesma resposta) —
  ver "Pontos que precisam de decisão" no relatório final.

### 3. O que pertence ao worker

- Puxar jobs da fila (`Queue.consume`).
- Fazer o claim atômico de cada `executionId` antes de processar.
- Chamar `processQueuedExecution(executionId)`.
- Aplicar timeout de processo (distinto do timeout do engine — ver
  "Timeout" abaixo).
- Decidir se um job que falhou por erro de infraestrutura deve voltar para
  a fila (retry) — nunca decide isso para um node que falhou de forma
  determinística (ver "Retry" abaixo).
- Nada do worker toca no engine diretamente além de chamar
  `processQueuedExecution` — ele não importa `lib/execution/executor.ts`
  nem `planner.ts` por conta própria, para não duplicar a lógica de
  orquestração que já existe em `execute-workflow.ts`.

## Decisões da Fase 4

### Lifecycle

```
queued → running → success | error | cancelled
```

Sem mudança na máquina de estados em si (já existe no schema desde a Fase
3 — `executions.status`). O que muda é **quem** pode fazer cada transição:

- `queued`: só `enqueueWorkflowExecution` cria uma execution nesse estado
  (via `createExecution` — mas note que hoje `createExecution` insere com
  `status:"running"` direto, porque o engine é síncrono; na Fase 4 ela
  passa a inserir com `status:"queued"`, e é o worker quem move para
  `running`). O reaper (ver "Recuperação após crash do worker") também pode
  devolver uma execution de `running` para `queued`, quando decide
  reprocessá-la em vez de encerrá-la.
- `running`: só o worker via claim atômico, **ou** o reaper via
  reconciliação por tempo (mesmo tipo de claim, sujeito a um teto de
  tentativas — ver abaixo). Nunca um update direto sem condição.
- `success | error | cancelled`: o worker ao final de
  `processQueuedExecution`, **ou** o reaper marcando `error` com
  `code:"WORKER_CRASHED"` quando o teto de tentativas é atingido.

### Idempotência

O **`executions.id`** (UUID já gerado pelo Postgres em `createExecution`)
é a chave de idempotência — não se inventa um ID novo em lugar nenhum. O
payload do job na fila deve carregar **só** `{ executionId }`, nada mais:
o worker sempre relê `workspaceId`, `workflowId` e o `document` snapshot
direto da linha `executions` no banco, nunca do payload do job. Isso evita
dois problemas ao mesmo tempo: (1) um job "velho" na fila nunca executa
com dados diferentes dos que estão persistidos agora; (2) não há superfície
de ataque em confiar em `workspaceId` vindo de uma mensagem de fila, mesmo
que fosse tecnicamente interna (mesmo princípio de "nunca confiar em
workspaceId do cliente" da Fase 3, estendido a "nunca confiar em dados que
vieram de fora do banco para decidir autorização").

**Evitar execução duplicada:** a maioria das filas reais (inclusive
qualquer candidata a Redis/BullMQ) garante *at-least-once delivery*, não
*exactly-once* — ou seja, o mesmo job pode chegar ao worker duas vezes
(reentrega após timeout de visibilidade, crash do worker antes do ack,
etc.). A defesa é um **claim atômico** no banco, não a fila:

```sql
UPDATE executions
SET status = 'running', started_at = now()
WHERE id = $1 AND status = 'queued'
RETURNING *;
```

Se isso retornar 0 linhas, outro worker (ou uma entrega duplicada) já
reivindicou essa execution — o worker atual simplesmente não faz nada e
confirma o job como processado (não é um erro, é o caso esperado de
entrega duplicada). Essa função não existe ainda no
`execution-repository.ts` — é a primeira das duas adições necessárias à
camada de persistência para a Fase 4 (a segunda é o reaper, que usa a
mesma ideia com uma condição diferente — ver "Recuperação após crash do
worker" abaixo, incluindo a coluna nova `claim_attempts` que esse claim
simples ainda não precisa incrementar, só o reaper).

### Retry

Fica inteiramente no worker/fila, **nunca** dentro do engine (o engine não
tem — e não deve ganhar — noção de tentativa/retry; ele responde uma vez,
determinística, para o input que recebeu). Duas categorias, que precisam
ser tratadas de forma diferente:

- **Falha de infraestrutura** (worker crashou, processo matou por OOM,
  perda de conexão com o banco no meio do processamento): isso é candidato
  a retry — a fila reentrega o job, o claim atômico acima garante que não
  duplica trabalho já persistido.
- **Falha determinística de um node** (`status:"error"` retornado pelo
  próprio engine — por exemplo um `NOT_IMPLEMENTED`, ou uma config
  inválida): **não deve ser reenfileirada automaticamente**. Rodar de novo
  o mesmo `WorkflowDocument` com o mesmo input vai produzir o mesmo erro —
  é dinheiro/tempo jogado fora, e no caso de nodes que algum dia fizerem
  chamadas externas (HTTP, IA, WhatsApp), retry automático de um erro
  determinístico pode causar efeito colateral duplicado (ex.: mandar a
  mesma mensagem duas vezes). O campo `ExecutionError.retryable` já existe
  no domínio (`lib/execution/types.ts`) exatamente para essa distinção —
  hoje nenhum executor o marca como `true`; quando existir, é o worker
  quem decide se vale a pena reenfileirar, olhando esse campo, não a fila
  por conta própria.

### Cancellation

O engine já suporta isso — `runExecutionPlan` aceita um `AbortSignal` e
checa `signal.aborted` antes de cada node (`lib/execution/executor.ts`).
O que falta é a ponte entre "alguém pediu para cancelar" (fora do processo
do worker) e esse `AbortSignal` (dentro do processo do worker). Proposta
mínima: uma coluna (`cancellation_requested_at timestamptz`, não criada
ainda) na tabela `executions`; um pedido de cancelamento é só um
`UPDATE executions SET cancellation_requested_at = now() WHERE id = $1`.
O worker, entre um node e outro (ele já tem esse ponto de checagem — é o
mesmo loop que checa `signal.aborted`), consulta essa coluna
periodicamente e chama `abortController.abort()` quando ela aparecer
preenchida. **Não** cria uma API pública de cancelamento agora — mesma
postura da Fase 3 (item 29 do prompt original), só descrevendo o mecanismo
que vai sustentar essa API quando ela existir.

### Timeout

Duas camadas distintas, que já existem em conceito ou vão existir:

1. **Timeout do engine** (`EXECUTION_LIMITS.MAX_EXECUTION_TIME_MS`,
   `lib/execution/types.ts`) — já implementado, já testado, não muda. Ele
   protege contra um workflow que roda "para sempre" dentro de uma chamada
   de `runExecutionPlan` que está, de fato, executando.
2. **Timeout do job/worker** — uma camada nova, de infraestrutura, que
   protege contra o caso em que o *processo do worker* trava sem nunca
   retornar (loop infinito por bug, hang de I/O, o processo morre sem
   liberar o job). Isso não é algo que o engine pode se proteger sozinho —
   é responsabilidade da fila (visibility timeout / lock TTL, dependendo
   da implementação escolhida) redistribuir o job para outro worker depois
   de um tempo sem confirmação. É por isso que esse requisito entra como
   critério de escolha da fila (ver seção final), não como algo a
   implementar agora.

### Recuperação após crash do worker — DECIDIDO

**Escolha: job de varredura (reaper) periódico, não depender só da
reentrega da fila.** Comparando as duas opções levantadas anteriormente:

- **Claim de "running" expirado, embutido na fila:** depende de que a fila
  escolhida reentregue a mensagem depois de um timeout de visibilidade —
  mas isso só acontece se a fila achar que o worker "sumiu" segundo os
  critérios *dela*, que são de mensageria, não de execução de workflow. Se
  o worker morre bem depois de dar ack (raro, mas possível dependendo da
  ordem crash/ack) ou se a fila escolhida não tiver esse conceito de forma
  nativa, a execution fica presa para sempre, sem qualquer processo
  olhando para ela de novo.
- **Reaper separado:** não depende de nenhuma garantia da fila — é uma
  varredura própria, no mesmo banco onde já vive `executions`, usando o
  mesmo tipo de claim atômico (`UPDATE ... WHERE ... RETURNING`) já
  desenhado para o caso `queued → running`, só que com a condição `status =
  'running' AND started_at < now() - <timeout>`. Isso não depende de
  nenhuma decisão de tecnologia de fila (que ainda nem foi feita), e reusa
  exatamente o mesmo padrão de concorrência já especificado.

Escolhido o reaper pelo motivo acima: ele não fica refém de uma garantia
de uma tecnologia de fila que ainda não escolhemos, e generaliza melhor
quando a fila mudar no futuro.

**Timestamps/estado necessários (schema — não criado agora, listado para a
etapa 4C):**
- `executions.started_at` — já existe, reaproveitado como "hora do claim
  mais recente" (o reaper atualiza esse campo ao reclamar, não só o
  worker original).
- `executions.claim_attempts integer default 0` — **coluna nova**,
  incrementada a cada claim (pelo worker normal ou pelo reaper). Sem isso,
  um workflow que sistematicamente derruba o worker (bug real, não
  transitório) seria reprocessado para sempre.
- Uma constante de configuração `MAX_CLAIM_ATTEMPTS` (sugestão: 3) e um
  `REAPER_TIMEOUT_MS` maior que `EXECUTION_LIMITS.MAX_EXECUTION_TIME_MS`
  com folga (sugestão: `MAX_EXECUTION_TIME_MS + 60_000`, para nunca competir
  com uma execução genuinamente longa e ainda saudável).

**Como evitar dois workers processando a mesma execution:** a mesma
garantia já vale para o reaper — é um único `UPDATE ... WHERE status =
'running' AND started_at < now() - interval AND claim_attempts <
$MAX_CLAIM_ATTEMPTS RETURNING *`. O lock de linha do Postgres durante o
`UPDATE` garante atomicidade entre múltiplas instâncias de worker/reaper
rodando ao mesmo tempo — não é necessário nenhum lock distribuído externo.
Quando `claim_attempts >= MAX_CLAIM_ATTEMPTS`, o reaper faz a transição
final para `error`/`WORKER_CRASHED` em vez de reclamar de novo — isso
também precisa ser uma condição na mesma query (ou uma segunda query que só
roda quando a primeira não encontra nada para reclamar).

**Como manter at-least-once sem duplicação perigosa:** esta decisão só é
segura **hoje**, porque nenhum executor tem efeito colateral observável
fora do próprio banco (`set`/`transform`/`if`/`switch`/`merge`/`delay` são
todos livres de efeito externo; `httpRequest`/`code` são `NOT_IMPLEMENTED`
— ver `docs/node-executors.md`). Reprocessar do zero uma execution que foi
interrompida no meio é seguro precisamente porque não existe ainda nenhum
node que "manda um WhatsApp" ou "cobra um cartão" de verdade. **Isso muda
assim que a Fase 5+ implementar executors com efeito externo real** — a
essa altura, reprocessar do zero deixa de ser seguro por padrão, e vai
exigir ou (a) resumabilidade real (pular nodes já registrados em
`execution_nodes` para aquela execution) ou (b) chaves de idempotência
próprias por chamada externa (ex.: enviar ao provedor de WhatsApp um
`Idempotency-Key` derivado de `executionId + nodeId`, se o provedor
suportar). Registro isso explicitamente como **pré-requisito a resolver
antes de qualquer executor com efeito colateral externo ser implementado**
— não é opcional, é bloqueante para essa fase futura, mas não bloqueia a
Fase 4 em si.

### Autorização — DECIDIDO: dois modelos distintos

Fecho aqui a questão que a auditoria anterior tinha deixado em aberto, e
que muda o desenho original do "worker chama as mesmas funções do
repository com userId/workspaceId da linha `executions`" — essa ideia
inicial ainda tratava o worker como se fosse "o usuário", só que atrasado.
Não é isso. **O worker é um processo interno confiável — ele nunca deveria
precisar reprovar uma permissão que já foi validada uma vez.** Dois
modelos de autorização, para dois tipos de acesso diferentes:

**Modelo 1 — pedido de um usuário vivo (enqueue e leitura):**
`requireWorkspaceMembership(userId, workspaceId)` continua exatamente como
hoje. Toda vez que existe uma sessão HTTP autenticada por trás da chamada
(alguém clicando "Execute", ou consultando o resultado depois), a
membership é revalidada **no momento da chamada**, contra o estado atual
do banco — nunca contra um estado antigo. Isso cobre:
- **Quem pode iniciar:** qualquer membro do workspace no momento do
  enqueue (igual hoje).
- **Quem pode ler o resultado:** qualquer membro do workspace **no
  momento da leitura** — não precisa ser quem criou a execution
  (`createdBy` é só metadado de auditoria, não uma trava de acesso;
  qualquer membro do workspace já pode ver o workflow inteiro hoje, então
  também pode ver as execuções dele).

**Modelo 2 — trabalho já autorizado, concluído por um processo interno
(o worker):** o worker **não chama `requireWorkspaceMembership` para
nada**. Ele opera com `executionId` como única fonte de verdade e única
credencial — o `workspaceId`/`document` que ele usa vêm de **ler a própria
linha `executions`** (que só existe porque já foi criada por um enqueue
legitimamente autorizado), nunca de um parâmetro que alguém possa
forjar. Consequência prática: as funções de escrita chamadas pelo worker
(`finishExecution`, `insertExecutionNodes`, o claim atômico) precisam de
uma variante que aceite **só `executionId`** — sem `userId`/`workspaceId`
como parâmetros de autorização — porque não existe "usuário atual" no
contexto de um worker. Isso é uma mudança de assinatura necessária nessas
três funções (não feita agora — é trabalho de 4C/4D), mas o princípio já
está fechado: **quem pode executar é quem já enfileirou legitimamente —
essa autorização não expira no meio do processamento.**

**O que acontece se a membership for revogada durante a execução:** o
worker termina e persiste o resultado normalmente (Modelo 2 — não
revalida). O que muda de fato é só o Modelo 1: se esse mesmo usuário (agora
sem membership) tentar **ler** o resultado depois, `GET
/api/executions/[executionId]` vai negar — porque a leitura é sempre
avaliada contra o presente. Um colega que continua no workspace consegue
ler normalmente. Isso prioriza exatamente o que foi pedido: **integridade**
(o trabalho que já era legítimo se completa e não se perde) e **isolamento**
(ninguém fora do workspace atual, seja qual for sua situação passada, lê
nada). Não inventei nenhuma permissão administrativa nova — só separei "
autorização para agir agora" de "autorização para ter mandado agir antes".

### Snapshot do workflow

Sem mudança de princípio da Fase 3 — só uma extensão de quando ele é
tirado. Hoje (síncrono), o snapshot é lido e usado na mesma chamada. No
modelo assíncrono, o snapshot precisa ser tirado **no enqueue**, gravado em
`executions.document` (coluna que já existe), e o worker **nunca** volta a
consultar `workflows.document` — ele só lê o snapshot já salvo via
`getExecutionById`. Isso garante que editar o workflow entre o clique em
"Execute" e o worker efetivamente rodar não muda o que vai ser executado —
o mesmo comportamento que já existia para uma execução em andamento
(Fase 3), agora estendido para cobrir também o tempo em que o job está
parado na fila.

## `GET /api/executions/[executionId]` — contrato (não implementado)

Rota nova, ainda não criada (etapa 4F). Fecha o caminho que falta para a UI
migrar de "POST → resultado" para "POST → executionId → GET
status/resultado", sem implementar polling/SSE agora — só o contrato que
o polling (quando existir) vai chamar repetidamente.

**Autenticação:** igual a toda rota hoje — `getCurrentUser()` → 401 se
nulo.

**Autorização:** Modelo 1 da seção anterior — `workspaceId` derivado do
usuário autenticado (`ensureDefaultWorkspace`, nunca do client), depois
`getExecutionById(userId, workspaceId, executionId)` — **função que já
existe, sem nenhuma mudança necessária**, porque ela já faz exatamente
essa checagem desde a Fase 3.

**Execution inexistente ou de outro workspace:** `getExecutionById` já
devolve `null` nos dois casos, sem distinguir um do outro (mesmo padrão
de `workflows`) → a rota responde `404` com um único código
(`EXECUTION_NOT_FOUND`), nunca revelando se a execution existe em outro
workspace.

**Response, por status:**

```jsonc
// queued
{ "executionId": "...", "status": "queued" }

// running
{ "executionId": "...", "status": "running", "startedAt": "..." }

// success
{ "executionId": "...", "status": "success", "result": { "items": [...] } }

// error
{ "executionId": "...", "status": "error",
  "error": { "code": "...", "message": "...", "nodeId": "..." } }

// cancelled
{ "executionId": "...", "status": "cancelled",
  "error": { "code": "EXECUTION_CANCELLED", "message": "..." } }
```

Mesmo formato de erro que `POST /execute` já usa (`lib/execution/result.ts`)
— não é um terceiro sistema de erros.

**Achado que bloqueia essa rota hoje, precisa entrar em 4C:** o resultado
final (`RunPlanOutcome.finalOutput`) é calculado pelo engine em memória a
cada chamada síncrona, mas **nunca é persistido** — `executions` não tem
uma coluna para isso hoje (só `document`, `error`, timestamps). Sem uma
coluna `result jsonb` nova, o `GET` não teria de onde ler o resultado de
uma execution já terminada. Isso não é uma escolha de design, é uma
lacuna real que precisa ser fechada em 4C (schema), gravando o mesmo
`finalOutput` que o worker já vai ter calculado — nenhuma lógica nova,
só parar de descartar um valor que já existe.

**Acesso aos resultados:** o corpo nunca inclui o `document` (snapshot do
workflow) nem os `execution_nodes` individuais nesta primeira versão — só
o agregado. Se um painel por-node vier a ser necessário, é uma extensão
aditiva do contrato acima (um array `nodes`), não uma mudança de formato.

## Fila — decisão conceitual (sem implementação)

```ts
interface Queue<Job> {
  enqueue(job: Job): Promise<void>;
  consume(handler: (job: Job) => Promise<void>): void;
}

type ExecutionJob = { executionId: string };
```

**Comparação:**

| Critério | Upstash Redis + BullMQ | Fila baseada em Postgres (`SELECT ... FOR UPDATE SKIP LOCKED` / claim atômico) |
|---|---|---|
| At-least-once | Sim, nativo | Sim, via claim atômico (já especificado acima) |
| Retries | Sim, nativo (backoff configurável) | Sim, via `claim_attempts` + `available_at` (a construir, mesmo padrão do reaper) |
| Visibility/recovery | Sim, nativo (stalled job detection) | Sim, mas é o reaper que construímos acima — não vem de graça |
| Jobs atrasados | Sim, nativo | Sim, trivial (`WHERE available_at <= now()`) |
| Worker fora de serverless | Sim (exige conexão Redis persistente) | Sim (só precisa de uma conexão Postgres, que o worker já vai ter de qualquer forma) |
| Infraestrutura nova | Sim — conta Upstash, conexão Redis adicional | Nenhuma — já temos Postgres/Supabase |
| Consistência com o estado de `executions` | Duas fontes de verdade (fila + banco) que podem divergir (BullMQ diz "completed", o `UPDATE` no Postgres falha) | Uma fonte de verdade só — a fila **é** a tabela `executions` |
| Simplicidade operacional | Mais um serviço para provisionar/monitorar | Nenhum serviço novo |

**Escolha: fila baseada em Postgres**, não Redis/BullMQ, pelos motivos
acima — e principalmente porque já tínhamos que desenhar o claim atômico e
o reaper de qualquer jeito (seções anteriores), então grande parte do que
BullMQ ofereceria de graça já está sendo construído à mão de qualquer
forma. Ter **uma única fonte de verdade** (a própria tabela `executions`,
sem um sistema de fila externo com seu próprio estado) elimina uma classe
inteira de bug de consistência (fila e banco discordando sobre se um job
terminou). O worker, nesse desenho, é só um processo Node comum que faz
polling periódico (`SELECT ... FOR UPDATE SKIP LOCKED` ou o `UPDATE ...
RETURNING` já especificado) — roda fora de qualquer função serverless,
como já era exigido.

**Quando reconsiderar Redis/BullMQ:** se o volume de execuções crescer a
um ponto em que polling em Postgres vire gargalo de latência/contenção de
lock, ou se surgir necessidade real de múltiplos workers especializados
consumindo filas diferentes (não é o caso hoje — só existe um tipo de job).
Não há evidência disso agora; a escolha acima é para o estágio atual do
projeto, não uma rejeição permanente de Redis.



## O que este documento explicitamente não resolve

A API pública de cancelamento (mecanismo descrito, endpoint não desenhado —
mesma postura da Fase 3, item 29: não construir antes de precisar); a UI
de acompanhamento de uma execução em andamento (polling/SSE/WebSocket —
fora de escopo desta etapa por instrução explícita, mas agora tem um
contrato de `GET` para se apoiar quando for construída); e o pré-requisito
de resumabilidade/idempotência por chamada externa antes de qualquer
executor com efeito colateral real (HTTP/IA/WhatsApp) — marcado acima como
bloqueante para essa fase futura, não para a Fase 4.

Os três pontos que a auditoria anterior tinha deixado em aberto
(recuperação de worker morto, autorização do worker, contrato de leitura
assíncrona) estão fechados nas seções acima.



## Auditoria F4F — fencing token e o que ficou em aberto

Esta seção registra o resultado da auditoria da Fase 4F. Ao contrário das
fases anteriores, as semânticas de lifecycle aqui **foram executadas contra
um PostgreSQL 16 real** (cenários A–F do handoff, mais os casos abaixo),
não apenas revisadas estaticamente. O que continua sem validação runtime é
o código TypeScript em si — `node_modules` segue indisponível (registry npm
responde 403), então `vitest` não roda.

### Corrigido: `finishQueuedExecution` não tinha nenhuma guarda

O `WHERE` era só `id = executionId`. Era a mesma classe de falha que a
auditoria já tinha encontrado em `abandonExecution`, mas no caminho
oposto — e com consequência pior, porque é a função que escreve o estado
*final* que o usuário vê. Dois comportamentos reproduzidos em Postgres real
antes da correção:

1. um worker que travou tempo suficiente para o reaper abandonar a execução
   (`error` / `WORKER_CRASHED`) sobrescrevia essa linha terminal com
   `success` ao acordar;
2. finalizar era repetível sem limite — qualquer chamada posterior
   substituía um status já final.

A correção usa **`claimAttempts` como fencing token**, sem coluna nova:
todo caminho de claim (`claimQueuedExecution`, `claimNextQueuedExecution`,
`reclaimExpiredExecution`) já incrementa esse contador, o que o torna uma
época monotônica de posse. O worker guarda o valor que recebeu no próprio
claim e devolve em `expectedClaimAttempts`; o `WHERE` exige
`status = 'running' AND claim_attempts = <época>`.

O guard de status sozinho **não** bastaria: depois de um reclaim a linha
volta a ser `running`, então só a época distingue o dono antigo do novo.
`finishQueuedExecution` retornando `null` significa "você não é mais o dono
desta execução" — o processor trata isso como `skipped` / `lease_lost`,
descarta o próprio resultado e não tenta reescrever.

Limitação conhecida e deliberadamente não resolvida agora:
`insertExecutionNodesInternal` continua sem fencing, então um worker que
perca a posse entre o insert dos nós e o finish deixa linhas em
`execution_nodes` penduradas numa execução finalizada por outro. Não afeta
o status terminal (a parte que o usuário lê) e só se torna alcançável
depois da decisão 1 abaixo.

### Resolvido — o reclaim devolve para a fila, e o ciclo fecha

`reclaimExpiredExecution` fazia `running -> running`. Não recuperava nada:
nenhum consumidor procura por `running` — `claimNextQueuedExecution` só
enxerga `queued`. O efeito real de um worker morto era **falha atrasada**,
não retomada: a linha era "reclaimada" até esgotar as tentativas e então
marcada `WORKER_CRASHED`, sem nunca ter voltado a rodar.

Agora a transição é `running -> queued`, que é o estado que o worker de fato
consome. Não há segundo sistema de fila: o próprio `queued` **é** a fila, então
devolver a linha para lá é literalmente reenfileirar. O reaper continua sem
executar nada — quem roda é o próximo `claimNextQueuedExecution()`.

```
queued → claim → running → worker executa → finish

worker morre no meio:
running (stale) → reclaim → queued → outro worker claim → running → finish
```

`startedAt` volta para `null` no reclaim: `queued` ainda não começou. Com isso
`startedAt` descreve sempre o claim **corrente**, nunca um anterior.

### Semântica de `claimAttempts`

É um contador de **claims**, e mais nada. Incrementa só quando alguém toma
posse para executar (`claimQueuedExecution`, `claimNextQueuedExecution`). O
reclaim **não** incrementa — quem paga a tentativa é o próximo claim, então uma
recuperação custa exatamente uma tentativa, não duas.

| momento | `claim_attempts` | `status` |
|---|---|---|
| criada (`createQueuedExecution`) | 0 | `queued` |
| worker A faz claim | 1 | `running` ← época de A |
| A trava; reaper reclama | 1 (inalterado) | `queued` |
| worker B faz claim | 2 | `running` ← época de B |
| … | | |
| worker C faz claim | 3 | `running` ← época de C |
| C trava; reaper **não** reclama | 3 | `error`, `WORKER_CRASHED` |

`MAX_CLAIM_ATTEMPTS` é o número máximo de execuções **tentadas**. O mesmo
número aparece nos dois lados da decisão do reaper: `reclaimExpiredExecution`
exige `claim_attempts < MAX` ("ainda cabe outra tentativa") e `abandonExecution`
exige `claim_attempts >= MAX` ("acabaram"). São complementares e avaliadas
atomicamente pelo banco, nunca em código de aplicação.

O mesmo valor é a **época** que identifica a posse. O worker guarda o
`claim_attempts` que recebeu no claim e o devolve em todo write final —
`finishQueuedExecution` e `insertExecutionNodesInternal`. Como todo claim
incrementa, um worker antigo nunca casa com a época corrente: não consegue
marcar `success`, `error` nem `cancelled`, não altera `result`, e não escreve
em `execution_nodes`.

`insertExecutionNodesInternal` também passou a **substituir** a tentativa
anterior em vez de acumular: agora que uma execução realmente roda mais de uma
vez, somar as linhas de A e de B apresentaria como histórico algo que nunca foi
um único run. A troca acontece dentro da mesma transação que segura o row lock
da execução, então o reaper não consegue reclamar a linha no meio.

### Resolvido — execução síncrona fora do circuito de recuperação

Havia dois lifecycles escrevendo na mesma tabela:

```
SYNC   request → running → finishExecution        (createExecution)
ASYNC  queued  → running → finishQueuedExecution  (createQueuedExecution)
```

e o reaper procurava candidatos só por `status = 'running'`. Uma execução
síncrona legítima, ainda rodando dentro de uma request HTTP, era
indistinguível de um worker morto: reproduzido contra PostgreSQL real, quatro
varreduras a levavam de `claim_attempts = 0` até `WORKER_CRASHED`.

Dava para inferir a diferença por `claim_attempts = 0`, e a inferência até é
sólida hoje. Mas ela faz um contador de tentativas responder a uma pergunta de
**propriedade**, e passa a valer por coincidência das transições atuais, não por
regra. Em vez disso há uma coluna explícita, `runner`
(`0004_execution_runner.sql`):

| `runner` | quem executa | fila | reaper |
|---|---|---|---|
| `request` | uma request HTTP viva | nunca entra | nunca toca |
| `worker` | um worker da fila | é a fila | reclama e abandona |

Garantido pelo banco, não só pelo código:

- `CHECK (runner IN ('request','worker'))`;
- `CHECK (runner <> 'request' OR status <> 'queued')` — uma execução síncrona
  não pode existir na fila, então nenhum bug de aplicação consegue empurrá-la
  para dentro do circuito do worker;
- índice parcial `executions_recovery_idx ... WHERE runner='worker' AND status='running'`,
  que documenta no schema qual é o conjunto recuperável;
- default `'request'`, deliberadamente o valor **inerte**: se um insert futuro
  esquecer de declarar, o erro é "nunca é recuperada", não "o reaper pode matá-la".

E o caminho inverso também foi fechado: `finishExecution` (síncrono) passou a
exigir `runner = 'request' AND status = 'running'`. Sem isso, uma request
tardia podia escrever por cima de uma execução de worker — inclusive por cima
de um `WORKER_CRASHED` que o reaper já tinha decidido. Era o espelho exato do
bug que o fencing corrigiu do lado assíncrono.

### Ainda em aberto

- **Sem heartbeat/lease.** Continua impossível distinguir "worker morto" de
  "worker vivo porém mais lento que o limiar". O desenho é recuperação por
  timeout, e agora que um reclaim de fato reexecuta, isso deixou de ser
  inofensivo: um worker lento pode ter seu trabalho refeito por outro. Hoje
  nenhum executor tem efeito externo (`httpRequest` e `code` são
  `NOT_IMPLEMENTED`), então reexecutar não causa dano — e é exatamente por isso
  que heartbeat/lease precisa vir **antes** do primeiro nó com efeito externo.
- **Uma execução devolvida para `queued` e nunca reclamada fica lá para
  sempre.** O reaper só varre `running`. Fome na fila é problema do loop do
  worker, que ainda não existe.
- **Não há loop do worker nem agendamento do reaper.** As peças existem;
  nada as chama repetidamente.

### Resolvido — `redact()` não reescreve mais o documento

`createExecution` e `createQueuedExecution` guardavam `redact(document)`, e
o `redact` trocava o **valor** de qualquer propriedade cujo *nome* casasse
com `/token|password|secret|key|authorization|cookie|credential/i`, em
qualquer profundidade. O nó Set guarda `data.values` como um record cujas
chaves o usuário digita no editor, então um campo `bookingKey` ou
`tokenVoucher` virava `"[REDACTED]"` no documento salvo — e o caminho
assíncrono executa o documento salvo.

Duas coisas estavam erradas ali, e só a segunda é sobre segurança:

1. **corrompia o programa antes de rodar.** O síncrono planeja a partir de
   `workflow.document` em memória, então dava resultado certo em cima de um
   snapshot corrompido; o assíncrono executava o snapshot. O mesmo workflow
   tinha dois comportamentos.
2. **adivinhava.** Nome de propriedade não é evidência de segredo — o
   *namespace* em que ele vive é. `bookingKey` é um campo que um agente de
   viagem digitou; `Authorization` é um nome definido pela RFC 9110.
   Aplicar a mesma regra aos dois é o que tornava a heurística ao mesmo
   tempo destrutiva e não confiável.

**A separação agora é explícita:**

| | quem lê | conteúdo |
|---|---|---|
| documento de runtime | planner, executors, worker (`claimed.document`) | íntegro, nunca recebe `[REDACTED]` |
| cópia segura | resposta de API, auditoria, log | pode redigir |

`executions.document` guarda o documento **íntegro** — é obrigatório, porque
é a fonte que o worker executa. A redaction passou para o caminho de
**leitura**: `getExecutionById` (MODELO 1, o que um humano consome) devolve
uma cópia segura via `lib/workflows/redaction.ts`. O worker não passa por
ali — lê a linha direto de `claimQueuedExecution`, intacta.

E a redaction virou **alvo**, não heurística: mira o único lugar onde uma
credencial é de fato autorada hoje neste projeto — o `data.headers` de um nó
`httpRequest`, cujas chaves são nomes de header HTTP
(`lib/workflows/definitions/http-request.ts`, `headers: z.record(z.string())`).
Casar por nome ali **é** correto: esse namespace é definido pela especificação
HTTP, não pelo usuário. A lista é fechada e curta (`Authorization`,
`Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Auth-Token`),
comparada sem diferenciar maiúsculas.

Também deixou de haver redaction na persistência de `result`, de `output` de
nó e de `error`: são dados de runtime com as mesmas chaves autorais do
usuário (a saída de um Set carrega os nomes de campo que ele escolheu), e
redigi-los destruía a trilha de auditoria pelo mesmo motivo errado. Hoje
nenhum nó produz credencial — `httpRequest` e `code` são `NOT_IMPLEMENTED`.

**Quando existir um sistema de secrets de verdade:** ele não existe neste
projeto, e esta etapa não inventou um. Quando existir (cifrado em repouso,
referenciado por id a partir do config do nó), a redaction deve mirar
*aquela* estrutura explicitamente, e ser estendida em
`lib/workflows/redaction.ts` — nunca voltando a alargar o casamento por nome
sobre dados arbitrários do usuário. Proteção de credencial em repouso é
cifragem, não regex.



## Fase 4H — o produtor da fila existe; o consumidor não

Até aqui, `createQueuedExecution` não tinha nenhum call site de produção. A
fila, o claim, o processor, o fencing e o reaper existiam e estavam
validados — mas nada da aplicação colocava trabalho na fila. `POST
/api/workflows/<id>/execute` executava sempre de forma síncrona. (O arquivo
era `app/api/workflows/[workflowId]/execute/route.ts`; hoje é
`app/api/workflows/[id]/execute/route.ts` — ver "Dois débitos de
infraestrutura", no fim deste documento. A URL nunca mudou.)

### O que passou a existir

`server/execution/enqueue-workflow-execution.ts` — o produtor. É o espelho
de `executeWorkflow()` até o ponto em que aquela função liga o engine, e
para exatamente ali:

```
auth (da rota)
  → membership          (getWorkflowById → requireWorkspaceMembership)
  → workflow é do workspace
  → documento é executável   (buildExecutionPlan, só validação)
  → snapshot + linha "queued" (createQueuedExecution, runner 'worker')
  → job enfileirável          (enqueueExecution)
  → { executionId, status: "queued" }
```

Valida antes de enfileirar porque `buildExecutionPlan` é o mesmo validador
que o caminho síncrono e o worker já usam — não um segundo. Assim um
workflow inexecutável é recusado na fronteira da API, com erro acionável,
em vez de virar um job cujo único desfecho possível é falhar mais tarde. O
worker continua validando por conta própria quando reclama o job.

### Contrato da API

O endpoint é o mesmo e o padrão continua sendo o de antes:

| `mode` | HTTP | corpo | executa durante a request? |
|---|---|---|---|
| `"sync"` (padrão) | 200 | `{executionId, status, result \| error}` | sim |
| `"async"` | 202 | `{executionId, status:"queued"}` | não |

Um corpo sem `mode` se comporta exatamente como antes — nenhum chamador
existente muda. `input` junto com `"async"` é **recusado** com 400 em vez de
ignorado em silêncio: o job carrega só `{executionId}`, então um input do
chamador não teria como chegar ao worker.

### O que falta para o consumidor existir em produção

Isto não foi implementado, e não deve ser improvisado. O que falta, exato:

1. **Um processo que continue vivo.** Nada chama `claimNextQueuedExecution()`
   em laço. Não existe entrypoint de worker — nem `scripts/worker.ts`, nem
   script no `package.json`.
2. **Onde rodar esse processo.** O alvo de deploy é serverless (Vercel), e
   uma função com escopo de request não hospeda um laço de longa duração.
   As opções reais, sem escolher nenhuma aqui:
   - um processo separado sempre ligado (container/VM/Railway/Fly/Render)
     apontando para o mesmo `DATABASE_URL`;
   - um agendamento (cron) chamando uma rota que drena N jobs por disparo —
     limitado pelo timeout de função da plataforma, e com latência igual ao
     intervalo do cron;
   - `LISTEN/NOTIFY` do Postgres para acordar um processo que já esteja
     vivo — não substitui o item 1, só reduz a latência dele.
   Em qualquer opção, atenção ao pooling de conexão (o `.env.example` já
   menciona isso para deploy serverless).
3. **Alguém que chame o reaper.** `recoverStaleExecutions()` existe; nada a
   invoca periodicamente. Sem isso, o ciclo de recuperação da 4G está
   correto mas nunca dispara.
4. **A rota de leitura.** `GET /api/executions/[executionId]` — contrato já
   fechado neste documento, rota não criada.
5. **UI capaz de lidar com status não-terminal.** O `execution-store.ts`
   valida a resposta e rejeita qualquer `status` fora de
   `success|error|cancelled`; um corpo com `"queued"` cairia em "The server
   returned an unexpected response". Não há polling, não há página de
   histórico, não há refresh.

Por isso `"sync"` continua sendo o padrão e o editor **não** foi migrado:
uma execução criada com `mode: "async"` hoje fica corretamente enfileirada
e simplesmente espera. O produtor está ligado; o consumidor é a próxima
fase, e é pré-requisito de qualquer nó com efeito externo.


## Async Runtime Decision — Proposal

Análise apenas. Nenhum código funcional foi escrito nesta etapa: o único
arquivo alterado é este. A decisão de onde o consumidor da fila vive é
humana, e esta seção existe para que ela seja tomada contra fatos.

### Fatos confirmados no código e na infraestrutura

Do repositório:

- **Nenhum artefato de deploy de segundo serviço existe.** Não há
  `vercel.json`, `Dockerfile`, `docker-compose.yml`, `fly.toml`,
  `railway.json`, `render.yaml`, `Procfile` nem `.github/`. O repositório
  nunca foi configurado para hospedar outro processo.
- **Não existe mecanismo de agendamento de nenhum tipo** — nem no
  `package.json`, nem em configuração de plataforma.
- **O único processo separado que existe é `scripts/migrate.ts`**, e ele
  é o precedente útil: roda por `tsx` (que já é devDependency), conecta com
  `postgres(DATABASE_URL, { max: 1 })` direto e **não importa `@/lib/db`
  nem `@/lib/env`**.
- `lib/db/index.ts` cria `postgres(DATABASE_URL, { max: 1 })` — uma conexão
  por instância/cold start.
- `lib/env.ts` valida `publicEnv` **no import, incondicionalmente**, e
  `serverEnv` exige `SUPABASE_SERVICE_ROLE_KEY` e `ENCRYPTION_KEY` — que
  nada lê ainda. Qualquer processo que importe `@/lib/db` herda todas essas
  exigências, inclusive as `NEXT_PUBLIC_*`.
- `EXECUTION_LIMITS.MAX_EXECUTION_TIME_MS = 30_000` (30s). Logo
  `REAPER_STALE_MS = 90s`.
- `scripts/f4f-lifecycle-harness.sql` já implementa o reaper inteiro em
  plpgsql (`h.find_stale`, `h.reclaim`, `h.abandon`, `h.recover_one`,
  `h.sweep`) e ele passa contra PostgreSQL real. **Isso é prova de que o
  reaper não precisa de processo nenhum** — ele é SQL.

Da plataforma (consultado, não de memória):

- **Vercel Functions** com Fluid compute (padrão): default 300s em todos os
  planos; máximo 300s no Hobby, 800s no Pro/Enterprise, 1800s em beta
  (Pro/Enterprise).
- **Vercel Cron**: Hobby = **uma vez por dia**, precisão de ±59 min; Pro e
  Enterprise = uma vez por minuto, precisão de minuto. 100 jobs por projeto
  em todos os planos.
- **Supavisor** (pooler do Supabase): transaction mode na porta 6543 devolve
  a conexão a cada query e **não suporta prepared statements**; session mode
  na porta 5432 mantém a conexão com o cliente. A doc não fala de
  LISTEN/NOTIFY explicitamente, mas a causa raiz é a mesma: transaction mode
  não preserva estado de sessão, e `LISTEN` é estado de sessão.
- **Supabase Cron** (`pg_cron`): intervalo mínimo de **1 segundo**, executa
  SQL puro ou dispara HTTP; limites de 8 jobs concorrentes e 10 minutos por
  job.

> Observação lateral, fora do escopo desta etapa mas relevante para a
> decisão: `lib/db/index.ts` não passa `prepare: false`. Se o
> `DATABASE_URL` apontar para o pooler em transaction mode (6543), que é o
> que o `.env.example` recomenda para deploy serverless, prepared statements
> do postgres.js não funcionam nesse modo. Vale confirmar qual string está
> em uso antes de qualquer deploy.

### As opções, comparadas tecnicamente

|  | A — processo persistente | B — cron drenando | C — LISTEN/NOTIFY | D — Supabase Cron |
|---|---|---|---|---|
| `claimNextQueuedExecution()` | laço contínuo com backoff | N vezes por invocação | ao acordar do NOTIFY | SQL direto, ou HTTP→rota |
| `processQueuedExecution()` | no próprio processo | dentro da função | no processo de A | só via HTTP→Vercel |
| Onde roda | fora da Vercel | Vercel Function | exige o processo de A | dentro do Postgres |
| Reaper | mesmo processo | outro cron | não ajuda | **SQL puro, sem processo** |
| Latência de fila | ~backoff (ms–s) | ≥ intervalo do cron | ~ms | ~1s se quiser |
| Novo serviço externo | **sim** | não | sim (é A) | não |

**A — processo worker persistente externo.** Um `while(true)` chamando
`claimNextQueuedExecution()` e, quando vem job, `processQueuedExecution()`.
Roda em container/VM apontando para o mesmo Postgres; a Vercel continua
hospedando só a API. Conexões: +1 por instância (`max: 1`), e pode usar
session mode direto, sem pooler. Worker morto é exatamente o caso que o
reaper da 4G já trata; múltiplos workers são seguros porque `SKIP LOCKED`
distribui e o fencing protege a escrita. Limitação real não é técnica e sim
operacional: é um segundo serviço para deployar, monitorar, e onde replicar
secrets. E, pelo `lib/env.ts` acima, ou ele segue o precedente do
`migrate.ts` e conecta direto, ou precisa satisfazer variáveis
`NEXT_PUBLIC_*` que nada nele usa.

**B — cron drenando jobs.** Uma rota drena até N jobs por disparo.
Compatibilidade com Vercel é nativa, mas os números decidem:

- No **Hobby**, Vercel Cron roda **uma vez por dia** com ±59 min. Como
  consumidor de fila isso não existe — uma execução assíncrona esperaria
  até ~24h.
- No **Pro**, uma vez por minuto: a latência mínima de um job é o intervalo
  do cron, então ~60s no pior caso antes de começar.
- Quantos jobs por disparo: com `maxDuration` de 300s (default) e 30s por
  workflow no pior caso, ~10 jobs; com 800s (máximo Pro), ~26.

O ponto forte é que a arquitetura já está preparada para o modo de falha
dessa opção: a função pode ser morta pelo timeout no meio de um job, o que é
*exatamente* o cenário "worker morre no meio" que a 4G resolve — reclaim
devolve para a fila, fencing impede a escrita tardia. Dois disparos
sobrepostos também são seguros pelo mesmo motivo. Conexões: uma por
invocação, curta. Não exige serviço novo, mas **exige plano Pro** para ser
viável — ou o disparo da opção D.

**C — LISTEN/NOTIFY.** Não é uma opção autônoma, por três motivos
independentes:

1. `LISTEN` exige uma sessão viva segurando a conexão — ou seja, já exige o
   processo da opção A. É otimização de latência sobre A, não alternativa a
   ela.
2. Em transaction mode (6543, o recomendado no `.env.example` para
   serverless) a conexão volta ao pool a cada query, então não há sessão
   para escutar. Precisaria de session mode (5432).
3. `NOTIFY` não é durável: se ninguém está escutando no instante do evento,
   a mensagem se perde. Qualquer desenho com NOTIFY precisa manter o polling
   como fallback, senão um job enfileirado durante um restart do worker
   nunca é descoberto.

Além disso nada no código emite `NOTIFY` hoje — exigiria trigger no INSERT
ou chamada explícita. Para o reaper não ajuda em nada: o reaper é disparado
por tempo, não por evento.

**D — Supabase Cron (`pg_cron`), já disponível na infraestrutura atual.**
Duas aplicações bem diferentes, e vale separá-las:

- **Para o reaper: resolve sozinho, hoje.** O reaper é SQL — o harness já o
  implementa inteiro em plpgsql e o prova contra PostgreSQL real. Um job de
  `pg_cron` chamando uma função `recover_stale_executions()` cobre o item
  "nada agenda o reaper" com zero processo, zero serviço novo e zero código
  de aplicação. O custo é a duplicação: a mesma lógica existiria em
  TypeScript e em SQL, e as duas teriam de ser mantidas em sincronia — um
  risco real, do mesmo tipo que o harness já carrega.
- **Para o worker: não resolve, mas melhora B.** O engine é JS e não roda
  dentro do Postgres. Mas `pg_cron` faz HTTP, então pode invocar a rota de
  drain da Vercel a cada 1s–1min, contornando o limite de uma vez por dia do
  Hobby e o de uma vez por minuto do Pro. Isso desacopla a viabilidade de B
  do plano da Vercel.

Variantes gerenciadas que apareceram na doc da Vercel (Queues, Workflows)
ficam de fora: adotá-las significa um segundo store de jobs ou um runtime
novo, e a decisão de manter a fila no Postgres foi tomada de propósito.
Registrado aqui só para constar que foram consideradas.

### Contrato necessário do `GET /api/executions/[executionId]`

Não implementado nesta etapa. O modelo existente já determina quase tudo:
`getExecutionById(userId, workspaceId, executionId)` já autentica por
membership (MODELO 1), já filtra por workspace no próprio `WHERE`, já traz
as linhas de `execution_nodes` e já devolve o documento em cópia segura.
Falta só a rota.

```
GET /api/executions/[executionId]

200 {
  executionId, workflowId,
  status: "queued" | "running" | "success" | "error" | "cancelled",
  createdAt, startedAt | null, finishedAt | null, durationMs | null,
  result?, error?: { code, message, nodeId? },
  nodes?: [{ nodeId, nodeType, status, durationMs, startedAt, finishedAt, error? }]
}
401  não autenticado
404  inexistente OU de outro workspace — indistinguíveis, como no POST
```

Duas decisões de contrato que a implementação vai precisar:

- **`claimAttempts` e `runner` não devem entrar na resposta.** São estado
  interno de posse; expor a época do fencing dá a um cliente material para
  raciocinar sobre o lock, sem nenhum benefício para a UI.
- **`document` entra ou não?** `getExecutionById` já devolve a cópia segura,
  então é seguro — mas é um payload grande para um endpoint que a UI vai
  chamar em polling. Provavelmente fora por padrão.

### Heartbeat / lease — como se encaixaria

**Quais campos atuais são insuficientes.** Existem dois: `started_at` e
`claim_attempts`. `started_at` responde "quando o claim corrente começou" —
não "quando o worker deu sinal de vida pela última vez". Com ele só dá para
perguntar há quanto tempo começou, e é por isso que worker lento e worker
morto continuam indistinguíveis. `claim_attempts` responde outra pergunta
(de quem é, e quantas tentativas já houve) e não ajuda nessa.

**O que precisaria ser atualizado:** um `heartbeat_at` renovado
periodicamente pelo worker *durante* a execução (migration nova; nenhum
campo atual serve). O reaper passaria a comparar o limiar contra
`heartbeat_at` em vez de `started_at`, e `started_at` continuaria
significando "início do claim corrente".

**Como o reaper distinguiria:** worker vivo renova; worker morto para de
renovar. Um worker legitimamente lento continua renovando e portanto deixa
de ser recuperado — que é exatamente a distinção que hoje não existe.

**Interação com `claimAttempts`:** nenhuma. São perguntas diferentes —
heartbeat responde "está vivo?", `claimAttempts` responde "de quem é?".
Nenhum dos dois substitui o outro.

**Interação com o fencing: heartbeat NÃO elimina o fencing.** Um worker pode
ficar particionado (pausa de GC, rede, suspensão da VM), perder a janela de
renovação, ser recuperado, e então voltar à vida e tentar escrever. Nenhum
heartbeat impede isso, porque o worker só descobre que perdeu a posse quando
tenta escrever. Só a época rejeita essa escrita. Heartbeat reduz a
*frequência* do cenário; fencing é o que garante a *correção* dele.

**Como evitar que dois workers executem o mesmo job:** não se evita
completamente sem consenso distribuído. O que se garante — e já está
garantido — é que no máximo um consegue **escrever** o resultado. Enquanto
os executores forem puros isso basta. No momento em que existir efeito
externo, deixa de bastar, e o que entra é idempotência por integração, não
mais heartbeat.

**Múltiplas instâncias:** cada worker renova o heartbeat da linha que
possui; nenhuma coordenação entre workers é necessária, porque a linha é o
lock.

**E um ponto que muda a ordem das fases:** o valor do heartbeat depende da
opção escolhida. Na opção A, onde o processo vive indefinidamente, ele é o
que separa lento de morto; na opção B, onde a invocação é curta por
construção, a janela em que a distinção importa é menor. **Implementar
heartbeat antes de escolher entre A e B é construir para um runtime que
ainda não existe.**

> **Correção (Fase 4I).** Uma versão anterior deste parágrafo dizia que, na
> opção B, "o timeout da plataforma já é, na prática, o heartbeat". Isso
> está errado e foi corrigido. Um timeout é um limite de execução: ele
> encerra uma invocação, e é por isso que o reclaim consegue recuperar o
> trabalho depois. Um heartbeat é uma confirmação periódica, escrita pelo
> próprio worker, de que ele continua vivo — informação que o timeout nunca
> produz e que nunca chega ao banco. Uma função congelada entre dois
> statements é indistinguível de uma saudável durante todo o tempo que
> restar do seu `maxDuration`. Operar sem heartbeat nesta fase é aceitável
> porque nenhum executor tem efeito externo e o fencing garante a correção
> — não porque o timeout faça o trabalho de um heartbeat.

### UI — mudanças exatas, sem quebrar o síncrono

Inspecionado: `execution-store.ts`, `execution-button.tsx`,
`execution-result-panel.tsx`.

1. **O tipo já admite `queued`.** `ExecutionUIStatus` é
   `"idle" | "running" | ExecutionStatus`, e `ExecutionStatus` inclui
   `"queued"`. O sistema de tipos não bloqueia nada.
2. **A validação de resposta bloqueia.** No `execute()`, a checagem
   `!["success","error","cancelled"].includes(body.status)` rejeita um corpo
   com `"queued"` e mostra *"The server returned an unexpected response."*
   Precisa aceitar o 202 e o status `queued` como resposta válida.
3. **Não existe polling.** Precisa de um laço que consulte o GET até o
   status ser terminal, com backoff, teto de tentativas e cancelamento ao
   fechar o painel ou desmontar — hoje não há nenhuma infraestrutura disso
   no projeto.
4. **`STATUS_LABEL` não tem `queued`** no result panel; cairia no fallback
   `?? status` e mostraria a string crua. Um rótulo resolve.
5. **O botão desabilita por `status === "running"`.** No modo assíncrono
   precisaria considerar `queued` também, senão dá para disparar várias
   execuções da mesma workflow em sequência.

Nada disso quebra o caminho síncrono: o modo é escolhido na chamada, e
mantendo `"sync"` como padrão o comportamento atual continua idêntico.

### Proposta técnica

Separar as duas decisões, porque elas têm urgências e custos diferentes:

**1. Reaper → Supabase Cron em SQL.** É a única peça que dá para fechar sem
decidir nada sobre o worker, sem serviço novo e sem processo. Já está
provada expressável em SQL pelo harness. O custo a aceitar conscientemente
é a duplicação da lógica em dois lugares.

**2. Worker → B (cron drenando), disparado por Supabase Cron, como primeiro
runtime; A como destino provável.** B é a menor mudança possível: nenhum
serviço novo, e o modo de falha dele (função morta pelo timeout no meio de
um job) é precisamente o que a 4G já resolve e validou. Usar Supabase Cron
como disparo em vez de Vercel Cron tira a viabilidade da dependência do
plano da Vercel. A latência de fila resultante — segundos a um minuto — é
aceitável para follow-up e análise de campanha, e provavelmente não é para
uma resposta de WhatsApp a um lead quente.

**O que torna essa escolha barata: ela é reversível.** O consumidor conversa
com o banco por três funções — `claimNextQueuedExecution`,
`processQueuedExecution`, `recoverStaleExecutions`. Trocar B por A depois é
trocar quem as chama, e não toca engine, planner, fencing, reclaim nem
reaper. Foi exatamente isso que as fases 4F/4G compraram.

**Ordem sugerida:** reaper em SQL → `GET /api/executions/[id]` → drain route
+ disparo → polling na UI → só então heartbeat (quando já se souber se o
worker é efêmero ou persistente) → efeitos externos → idempotência por
integração.

### Decisões que dependem de humano

1. **Plano da Vercel** (Hobby ou Pro). Decide se Vercel Cron é utilizável, e
   o teto de `maxDuration` (300s vs 800s), que por sua vez decide quantos
   jobs cabem por disparo.
2. **Aceitar ou não um segundo serviço.** É a diferença entre A e B, e é
   operacional antes de ser técnica: alguém precisa manter, monitorar e
   guardar secrets nesse outro lugar.
3. **Latência de fila aceitável por caso de uso.** Um minuto para um
   relatório de campanha é irrelevante; para responder um lead no WhatsApp,
   provavelmente não.
4. **Duplicar o reaper em SQL, ou esperar e manter só a versão TypeScript.**
   Fechar cedo com `pg_cron` custa manter duas implementações em sincronia.
5. **Qual connection string está em uso** (transaction 6543 vs session
   5432), com a observação sobre `prepare: false` acima. A opção C depende
   disso; A e B funcionam nas duas, com implicações diferentes de pooling.



## Fase 4I — o consumidor existe

O ciclo assíncrono fecha de ponta a ponta:

```
UI → POST /execute {mode:"async"} → 202 {executionId, status:"queued"}
                                      ↓
                              executions (a fila)
                                      ↓
        Supabase Cron ──HTTP──→ POST /api/internal/worker
                                      ↓
                    claimNextQueuedExecution()  (FOR UPDATE SKIP LOCKED)
                                      ↓
                    processClaimedExecution()   (engine + escritas com fencing)
                                      ↓
                              executions
                                      ↓
     UI ──polling──→ GET /api/executions/[id] → queued → running → terminal

        Supabase Cron ──HTTP──→ POST /api/internal/reaper
                                      ↓
                         recoverStaleExecutions()
```

### Uma correção de integração que isto expôs

`claimNextQueuedExecution()` (descoberta + claim, numa transação) e
`processQueuedExecution(id)` (claim + execução) reclamam a linha em lugares
diferentes. Usadas em sequência — que é o que um worker naturalmente faria —
a segunda encontra a linha já em `running`, devolve `not_claimable` e **não
executa nada**. O teste de integração escrito na fase anterior tinha
exatamente esse bug e nunca acusou, porque o vitest continua bloqueado.

A correção foi separar `processClaimedExecution(row)` de
`processQueuedExecution(id)`: a segunda reclama e delega para a primeira.
As duas portas de entrada convergem no mesmo lifecycle, que é o que a
documentação da fila sempre disse que elas deveriam fazer — em vez de o
worker ganhar uma segunda cópia das regras.

### O worker é bounded, e para por decisão própria

Três saídas, todas voluntárias: `empty_queue` (nada a fazer — volta em
milissegundos, o que torna um agendamento frequente barato), `max_jobs` (o
teto por invocação) e `deadline` (não há orçamento para começar outro job).

O deadline reserva um `MAX_EXECUTION_TIME_MS` inteiro antes de começar
qualquer job. Errar isso não é bug de correção — uma execução cortada no
meio é o caso "worker morreu", que o reclaim recupera e o fencing protege —
mas **é caro**: cada corte gasta uma das `MAX_CLAIM_ATTEMPTS`. Três
invocações truncadas seguidas abandonariam um workflow saudável como
`WORKER_CRASHED`. A reserva existe para que isso não seja rotina.

### Sobre não haver heartbeat nesta fase

O orçamento do worker **não é um heartbeat**, e nada neste código deve ser
lido como se fosse. Ele limita quanto tempo a invocação escolhe trabalhar;
não diz se o processo está vivo, e não chega ao banco. Uma função congelada
entre dois statements é indistinguível de uma saudável.

O que sustenta a correção nesta fase, e continua sustentando depois:

- **fencing** pela época do claim — um worker que perdeu a posse não
  escreve estado final nem linhas de nó;
- **reclaim** devolvendo a execução à fila;
- e o fato de que **nenhum executor tem efeito externo** (`httpRequest` e
  `code` seguem `NOT_IMPLEMENTED`), então reexecutar não causa dano.

Essa terceira perna é temporária por natureza. No instante em que existir um
nó que mande mensagem, crie reserva ou cobre, "reexecutar é inofensivo"
deixa de valer, e aí heartbeat/lease e idempotência por integração passam a
ser pré-requisito, não melhoria.

### Segurança dos endpoints internos

`/api/internal/worker` e `/api/internal/reaper` rodam trabalho privilegiado
sem sessão de usuário. Autenticação por `CRON_SECRET` em
`Authorization: Bearer`, comparado com digests SHA-256 de tamanho fixo via
`timingSafeEqual` — comparar as strings cruas encerraria cedo num tamanho
diferente e vazaria o comprimento do segredo.

**Falham fechado:** com `CRON_SECRET` ausente, recusam toda requisição
(503, `SCHEDULER_NOT_CONFIGURED`). Não existe modo em que segredo ausente
signifique "liberado" — um deploy que esqueça a variável fica com endpoints
inertes, nunca abertos.

E o endpoint do reaper **não aceita `staleMs`/`maxAttempts`**, embora a
função os aceite. Um chamador que passasse `staleMs: 0` transformaria o
reaper em arma: toda execução em andamento pareceria travada, voltaria para
a fila, e acabaria abandonada como `WORKER_CRASHED`. Esses parâmetros
existem para os testes comprimirem o tempo; não têm por que cruzar a rede,
autenticados ou não.

### Contrato do GET, e o que ele não devolve

`toExecutionDetailView` é uma **allowlist**, nunca um spread da linha. Um
spread faria qualquer coluna futura — uma referência de credencial, um
heartbeat, uma flag interna — começar a vazar para o navegador no momento em
que a migration entrasse, em silêncio. Ficam de fora `runner`,
`claimAttempts` (a época do fencing), o documento do workflow, `workspaceId`,
`createdBy` e os payloads por nó.

### Conexão com o Postgres

`lib/db/index.ts` passou a usar `prepare: false`. O `.env.example` recomenda
o pooler em transaction mode (6543), e esse modo devolve a conexão ao pool a
cada statement — um prepared statement criado numa conexão física não existe
na próxima. Sem isso, consultas que funcionam localmente falhariam em
produção de forma intermitente, sob pressão de pool. É o modo de falha mais
difícil de diagnosticar que havia aqui.


## Fase 9 — lease / heartbeat

### Três mecanismos diferentes, que é fácil confundir

| | pergunta que responde | quem escreve | o que garante |
|---|---|---|---|
| **timeout** | "esta execução pode durar mais?" | ninguém — é um limite | que uma execução termina, de um jeito ou de outro |
| **heartbeat / lease** | "alguém ainda está cuidando disto?" | o próprio dono, periodicamente | reduz falso reclaim de worker vivo |
| **fencing** | "quem pode escrever o estado final?" | ninguém — é uma condição | que só o dono corrente grava |

Um timeout encerra; ele nunca informa nada ao banco enquanto corre. Um
heartbeat informa, mas só enquanto o worker conseguir executar código. O
fencing não depende de tempo nenhum — é o único dos três que dá **garantia**.

### O que mudou

O sinal de recuperabilidade deixou de ser `started_at < now() - 90s` ("faz
muito tempo que começou") e passou a ser `lease_expires_at < now()`
("ninguém reafirmou que está cuidando disto"). A coluna é concedida
atomicamente no claim, renovada pelo worker, e limpa em qualquer transição
que tire a linha de "running".

```
claim            → lease = now() + 45s,  época = N
heartbeat (5s)   → lease = now() + 45s,  época inalterada
reclaim          → lease = NULL, volta para queued
finish / abandon → lease = NULL, estado terminal
```

`LEASE_DURATION_MS` (45s) é maior que `MAX_EXECUTION_TIME_MS` (30s) de
propósito: uma execução que use todo o tempo do engine não pode perder o
lease por isso, e ainda sobram 15s de folga. `HEARTBEAT_INTERVAL_MS` (5s)
dá 9 renovações por lease — 8 podem falhar antes de a linha ficar
recuperável.

O banco garante a invariante: `CHECK (lease_expires_at IS NULL OR (runner =
'worker' AND status = 'running'))`. Nenhum bug de aplicação consegue deixar
para trás um lease protegendo uma linha que não está mais sendo executada.

E **lease NULL conta como vencido**. Proteção contra recuperação tem de ser
afirmativa: uma linha "running" sem lease é uma linha que ninguém declarou
estar executando.

### O heartbeat não substitui o fencing

O caso que o lease sozinho não resolve: worker A trava, o lease vence, o
reaper devolve à fila, worker B assume — e então A descongela e renova. Sem
fencing, esse heartbeat estenderia o lease **de B**, e A seguiria achando
que é dono. Por isso a renovação carrega a mesma época das escritas finais:
`id + runner='worker' + status='running' + claim_attempts = época`. A época
de A não casa mais, então A não renova, não grava nós e não finaliza.

Validado contra PostgreSQL real, inclusive com duas sessões concorrentes —
um worker vivo renovando enquanto um reaper varre em paralelo não é
recuperado, e passa a ser no instante em que para de renovar.

### Limites, ditos com todas as letras

- **A renovação depende do event loop.** Medido neste projeto: um workflow
  inteiramente puro executa **sem que um único heartbeat dispare**, porque o
  engine encadeia `await` sobre promises já resolvidas e isso roda na fila
  de microtasks, drenada antes de o loop chegar aos timers. Um bloqueio
  síncrono tem o mesmo efeito. Ou seja: hoje, com todos os executores puros
  e execuções de milissegundos, quem limita um worker travado é o lease
  concedido no claim — a renovação é praticamente inerte. Ela passa a valer
  quando existir I/O real, que é exatamente quando execuções ficam longas o
  bastante para um falso reclaim importar.

- **O heartbeat cobre só a fase do engine.** É parado antes da persistência,
  que abre transação com row lock na mesma conexão. Persistência travada É
  worker travado; deixar o lease vencer ali é o comportamento certo.

- **Um processo congelado continua deixando o lease vencer.** É o desenho,
  não uma falha: quem garante a correção nesse caso é o fencing.

- **E o mais importante: heartbeat reduz falso reclaim, não garante
  execução única de efeito externo.** Se um nó mandar mensagem e o worker
  travar depois disso, o reclaim entrega o trabalho a outro worker e a
  mensagem sai de novo. O fencing impede o primeiro de gravar o resultado;
  não impede o WhatsApp de ter sido enviado duas vezes. Lease e fencing
  protegem o **estado no banco**. Nenhum dos dois desfaz efeito externo —
  isso é idempotência por integração, que é a fase seguinte e não esta.
  (Fase 10, abaixo: para nós que fazem efeito externo via `context.effects`,
  o reclaim deixa de reenviar — a operação vira `unknown` em vez disso.)

## Fase 10 — registro durável de operações externas

Nenhuma integração real existe nesta fase — nada envia mensagem, cobra
dinheiro ou mexe em conta externa. O que existe é a infraestrutura que
qualquer integração futura vai ter de usar, provada de ponta a ponta com um
provedor **falso** (`MockExternalEffect`).

### Três garantias diferentes, que não se substituem

| | pergunta que responde | o que NÃO garante |
|---|---|---|
| **fencing** (época) | "quem pode gravar o resultado desta EXECUÇÃO?" | que um efeito externo aconteceu uma vez só |
| **lease / heartbeat** | "alguém ainda está cuidando desta execução?" | idem — só reduz falso reclaim |
| **UNIQUE em `effect_operations`** | "já existe uma operação lógica para esta identidade?" | exactly-once externo — um POST já enviado não é desfeito por constraint nenhuma |

Fencing ≠ idempotência. Lease ≠ idempotência. Unicidade no banco ≠
exactly-once no mundo lá fora. O que impede o segundo envio é o **protocolo**
abaixo; o que ele promete depende do provedor, e está dito caso a caso.

Três coisas fáceis de confundir (`lib/execution/effects.ts`):

- **operação lógica** — "mandar o template X ao lead 42, nesta execução".
  Uma por identidade. Sobrevive a todo reclaim.
- **tentativa** — uma época tentando realizar essa operação. Uma por época.
- **efeito externo** — o que existe de fato lá fora: a mensagem no celular.
  Zero, uma, ou MAIS.

### Identidade: a chave idempotente

`effect_operations` não é "a tabela de idempotência": é o registro durável
de uma operação externa. A chave é uma **propriedade** dela:

```
idempotency_key = sha256( JSON canônico de ["v1", executionId, nodeId, businessKey, operation] )
```

- **Nunca** entra: época, `claim_attempts`, timestamp, id aleatório. Qualquer
  um deles muda entre tentativas, e uma chave que muda entre tentativas
  identifica a tentativa, não a operação.
- **`businessKey` é obrigatória** e nunca é o índice do item — nem como
  fallback. Depois de um reclaim o plano roda de novo desde o início; o
  primeiro nó não determinístico a montante (IA, HTTP de leitura, relógio)
  pode reordenar a lista, e "item 3" passaria a apontar para outro cliente
  com a mesma chave. Nada falharia; a pessoa errada seria afetada.
- A `businessKey` é **validada, nunca normalizada**: string não vazia, até
  256 caracteres, sem espaço nas bordas nem caractere de controle. Trim ou
  lowercase transformariam duas identidades em uma, em silêncio.
- Hash sobre uma **tupla**, não uma concatenação: `("a:b","c")` e
  `("a","b:c")` não colidem.
- Dentro de UM nó, dois itens com a mesma entidade e a mesma operação são a
  mesma operação: o segundo é replay (ou `payload_mismatch`, se o conteúdo
  diferir). Se um nó precisa agir duas vezes sobre a mesma entidade, a
  `businessKey` tem de dizer isso (`lead-42:boas-vindas`).
- **Escopo: uma execução.** Rodar o workflow de novo cria outra execução,
  outra chave — e envia de novo. Deduplicar ENTRE execuções ("nunca mandar
  as boas-vindas duas vezes ao mesmo lead") é regra de negócio de outra
  camada, e não foi contrabandeada para esta chave.
- **PII:** a `businessKey` fica gravada em claro. Prefira id interno a
  telefone ou e-mail.

### O protocolo

```
TX1  reserve   cria a operação, ou descobre que já existe         [commit]
TX2  begin     reserved -> in_flight, uma vez, para sempre         [commit]
     CALL      perform(idempotencyKey) — SEM transação aberta
TX3  record    o que o provedor respondeu, como FATO               [commit]
```

**Por que a chamada nunca fica dentro de uma transação.** Seria tentador
abrir a transação, chamar, e commitar só se deu certo, como se isso tornasse
os dois atômicos. Não torna:

1. o provedor não participa da nossa transação — se o commit falhar depois
   de ele aceitar, o efeito existe e o registro não: exatamente o caso que
   esta camada existe para tratar, só que escondido;
2. este projeto roda com UMA conexão por processo (`lib/db/index.ts`,
   `max: 1`): transação aberta durante uma chamada lenta trava o heartbeat
   do lease e toda outra query do worker pelo tempo que o provedor levar;
3. atrás do Supavisor em modo transação, transação aberta prende uma
   conexão física pela duração inteira.

**Por que o `begin` commita ANTES da chamada.** A ordem inversa (chamar,
depois gravar) deixaria um crash entre as duas com uma mensagem enviada
parecendo "reserved" — ou seja, segura para enviar de novo. Nesta ordem, o
único erro possível é o seguro: um crash depois do commit e antes da chamada
parece ambíguo mesmo sem nada ter saído. Dúvida falsa se resolve com uma
pessoa; segurança falsa é duplicata.

### Estados

| estado | significa | sai por |
|---|---|---|
| `reserved` | existe; ninguém cruzou o ponto sem volta | `begin` (dono) · `adopt` (época nova, continua reserved) |
| `in_flight` | uma época cruzou; o resultado ainda não foi gravado | fato da época que chamou · `adopt` → `unknown` · execução terminal → `unknown` |
| `succeeded` | o provedor confirmou; há referência | final — salvo se quem decidiu foi uma pessoa (ver abaixo) |
| `failed` | o provedor recusou em definitivo; nada aconteceu | idem; **sem retry automático** |
| `unknown` | pode ter acontecido ou não | resolução explícita por pessoa · fato da época que chamou |

**Cercar decisões por posse, fatos por autoria.** Decisões (reserve, adopt,
begin) exigem que a época ainda seja dona da execução: a linha de
`executions` é lida `FOR SHARE` na mesma transação. Fatos ("o provedor
confirmou a MINHA chamada") exigem só autoria: mesma execução e
`began_epoch = época` (a execução entra porque o número da época se repete
entre execuções — todo primeiro claim é a época 1). Aplicar
fencing de posse a fatos é o bug sutil que isto evita — descartaria a
confirmação tardia de um worker superado, deixaria a operação parecendo não
enviada, e causaria exatamente a duplicata que o fencing deveria impedir.
Reproduzido contra PostgreSQL antes de o código ser escrito.

**`unknown` é estado de primeira classe, e permanente.** Nada o transforma
em `failed` por tempo, nada o transforma em retry. Só saem dele:
(a) uma pessoa, explicitamente e com evidência do provedor
(`resolveUnknownEffectOperation`; o contrato inteiro — quem, quando, com que
prova — está na seção **Fase 10.5A**, abaixo); ou (b) um fato **do
provedor**, relatado pela época que fez a chamada — que não é inferência nem
timer, é a resposta que faltava.

**Resolução humana é juízo; resposta do provedor é evidência.** Dito de
outro jeito: **a pessoa resolve o estado operacional; o provedor informa o
fato externo.** A revisão
independente desta fase reproduziu: o worker trava ENTRE o `begin` e a
chamada, o reaper desiste (o trigger marca `unknown`), uma pessoa não acha
nada no painel e resolve como `failed` — e então o worker acorda e envia. Se
o fato tardio fosse descartado, o registro diria "nada aconteceu" sobre uma
mensagem entregue, e rodar o workflow de novo mandaria outra. Por isso a
resolução grava quem decidiu (`resolved_by_user_id`), e um fato da época que
fez a chamada **substitui** esse juízo; o histórico guarda os dois. Um fato
nunca substitui outro fato. Na prática: resolva uma operação só depois que a
chamada não puder mais responder — neste deploy, depois que a invocação do
worker que a fez terminou (`maxDuration`, 300s). *(Fase 10.5A: isso deixou de
ser recomendação — a resolução é recusada enquanto a execução não terminou e
antes de 600 s desde o `began`, no relógio do banco.)*

**Execução terminal não tem operação em voo.** Se a execução termina — o
worker finalizou sem conseguir gravar o fato, o reaper desistiu depois de
esgotar as tentativas, ou (caminho futuro) ela é cancelada ainda na fila —
não existe próxima época para adotar. Um trigger em `executions` (0006)
converte `in_flight` → `unknown` no MESMO commit da transição terminal, a
partir de **qualquer** estado não terminal, com evento de ator `system`.
Operações apenas `reserved` ficam como estão: nada foi enviado.

**O banco garante as transições, não só o código.** Um trigger em
`effect_operations` recusa qualquer escrita fora da máquina de estados:
identidade imutável, `began_epoch` gravado uma vez e nunca mais alterado,
`owner_epoch` só cresce, nada volta para `reserved`, resultado vindo do
provedor é final. Com isso, "o ponto sem volta é cruzado no máximo uma vez
por operação" vale para qualquer escritor — inclusive um script ou um
console. O que o banco NÃO impede: apagar a operação e reservá-la de novo; a
retenção só pode purgar operações de execuções terminais.

### Política: só AT_MOST_ONCE, e o preço dela

Depois que qualquer tentativa cruza o ponto sem volta, nenhuma outra envia.
O custo, dito sem rodeio:

- **crash antes da chamada (depois do `begin`) e crash depois da chamada são
  indistinguíveis** — gravam o mesmo estado e o mesmo histórico (verificado
  nos dois lados: Node e PostgreSQL). Os dois viram `unknown`. No primeiro,
  a mensagem **nunca é enviada** até alguém resolver;
- um `failed` não é tentado de novo automaticamente — nem quando seria
  seguro (recusa definitiva não aconteceu lá fora). Retry de falha
  definitiva é decisão de política futura;
- `unknown` num item faz o nó falhar (`EXTERNAL_EFFECT_UNKNOWN`) e a execução
  terminar em erro; itens seguintes não são tentados. Não existe "retomar"
  execução — depois de resolver, uma nova execução tem outra chave.

A alternativa — reenviar na dúvida — duplica. Para um provedor sem chave
idempotente não existe terceira opção.

### Provedores: com e sem chave idempotente

| provedor / operação | chave idempotente? | o que a chave estável compra |
|---|---|---|
| WhatsApp Cloud API — envio de mensagem | **não** (a referência da Meta documenta só `Authorization` e `Content-Type`) | nada no provedor: só o protocolo daqui. AT_MOST_ONCE é a única política segura |
| Mercado Pago — Payments e Refunds | **sim**, `X-Idempotency-Key` | deduplicação **segundo as garantias daquele provedor** ("only the first one is processed"), pelo tempo que ele guardar a chave — a documentação consultada não diz quanto. É propriedade do Mercado Pago, não deste engine |
| Google Ads API — mutate | **não encontrada** nas páginas de mutate consultadas | idem WhatsApp, até prova em contrário |

A chave derivada aqui é estável entre tentativas e é repassada a `perform`
justamente para provedores do segundo tipo. Operações naturalmente
idempotentes ("definir X = valor") e reconciliáveis por consulta ("existe
pagamento com minha referência?") poderiam ter políticas melhores
(AT_LEAST_ONCE, PROVIDER_IDEMPOTENT, RECONCILIABLE) — **nenhuma foi
implementada**; o banco só aceita `at_most_once`.

### Contrato do adaptador (para quem escrever a primeira integração real)

- `succeeded` só com referência NÃO secreta do provedor, utilizável como
  está (não vazia, imprimível, até 256 caracteres) — senão vira `unknown`,
  nunca `succeeded` sem evidência;
- `failed` só para recusa **definitiva** (erro de validação), e com o código
  de erro do próprio provedor — "nada aconteceu" também precisa de evidência;
  sem código, vira `unknown`;
- **qualquer outra coisa é `unknown`**: timeout, reset de conexão, 5xx,
  resposta ilegível. Timeout é justamente o caso em que o provedor aceitou e
  a resposta se perdeu. Exceção lançada também vira `unknown`;
- **o texto de uma exceção nunca é gravado** — só o nome da classe. A revisão
  reproduziu `fetch` recusando um header `Authorization` inválido com o token
  dentro da mensagem. `code`, `message` e `reason` do adaptador são gravados
  limpos (sem caractere de controle, NUL ou surrogate solto — que o jsonb do
  PostgreSQL recusaria) e truncados; mesmo assim, é o adaptador quem garante
  que não há segredo neles;
- cada chamada tem prazo (`EFFECT_CALL_TIMEOUT_MS`, 20s): passado o prazo o
  resultado é `unknown` e o nó segue. **O prazo de 20 segundos é o fim da
  NOSSA espera, não o cancelamento do efeito externo.** A chamada não é
  abortada — abortar um pedido que pode já estar na rede só garante nunca
  saber como terminou — e o provedor pode concluí-la depois; se a resposta
  chegar, é gravada como fato (melhor esforço: se o processo acabar antes,
  fica `unknown` até uma pessoa resolver). Quem escrever um executor não pode
  tratar "passou do prazo" como "não aconteceu";
- o executor usa SÓ `context.effects`, valida a `businessKey` de TODOS os
  itens antes do primeiro efeito, processa um item por vez, e reporta cada
  resultado como ele é (`unknown` ≠ `failed` ≠ `fenced`).
  `test-support/mock-effect-executor.ts` é o modelo. (Se dois itens da
  mesma entidade correrem em paralelo no mesmo processo, o runner os junta
  numa tentativa só: um envio, o outro recebe `replayed`.)

### Ficha de integração (antes de cada executor externo)

Cada integração nova começa por uma ficha, escrita a partir da documentação
do provedor — não da memória — e revisada antes do código, para que o engine
não finja que todos os provedores têm as mesmas garantias:

| campo | pergunta |
|---|---|
| operação | qual ação exata (ex.: `whatsapp.send_template`), e qual entidade é a `businessKey` |
| idempotência do provedor | aceita chave? qual header, em quais endpoints, por quanto tempo guarda, o que faz com a mesma chave e corpo diferente — com a fonte |
| reconciliação | dá para consultar depois se a operação aconteceu? por qual referência (id do provedor, referência externa nossa)? |
| política de retry | qual política o banco vai aceitar para ela (hoje só `at_most_once`) e por quê |
| resolução de `unknown` | que evidência uma pessoa usa para resolver: onde procurar, o que conta como "aconteceu" e como "não aconteceu" |
| referência externa | o que é gravado como `provider_reference`; confirmar que não é segredo |
| classificação do efeito | o que acontece se sair duas vezes (mensagem duplicada, cobrança duplicada, campanha alterada duas vezes) — a gravidade decide a política |
| confirmação tardia | o provedor confirma depois por conta própria (webhook)? em quanto tempo? — decide se o resfriamento de 600 s da resolução (Fase 10.5A) basta para esta integração |
| evidência para resolver | qual `evidence.source` se aplica (API, painel, webhook, suporte) e o que a pessoa anota — sem colar payload, header ou dado do cliente |

### Onde isto existe, e onde não

- **Só no caminho assíncrono.** O worker injeta `context.epoch` e
  `context.effects`; `execute-workflow.ts` (síncrono) não injeta nenhum dos
  dois, e o próprio `reserve` recusa execução com `runner = 'request'`. Um
  executor de efeito no caminho síncrono falha com
  `EXTERNAL_EFFECTS_UNAVAILABLE` — o síncrono não tem recuperação, logo não
  tem como resolver ambiguidade.
- O executor mock **não é registrado** em `lib/execution/executors/index.ts`;
  nenhum workflow de usuário alcança ele.

### O que nunca é gravado

O payload não é guardado — só `payload_fingerprint` (sha256 do JSON
canônico), para detectar a mesma identidade pedindo coisa diferente. Não
existe coluna para payload, header, token, cookie ou credencial (o harness
fixa a lista de colunas). Os campos de texto livre — código/mensagem de
erro, motivo do `unknown` — guardam só o que passa pelo runner: ele nunca
grava texto de exceção (só o nome da classe) e limpa e trunca o resto; que o
adaptador não coloque segredo em `message`/`reason` é parte do contrato dele,
não algo que esta camada consiga verificar. (O texto que uma PESSOA escreve
ao resolver — justificativa e evidência — tem regras próprias: Fase 10.5A,
"LGPD como regra de engenharia".)
`provider_reference` é o id não secreto do provedor.

Observação honesta: o fingerprint é hash, não criptografia — quem lê a
tabela consegue testar um palpite de payload de baixa entropia. Ele existe para comparar, não para anonimizar; a leitura é
restrita por RLS a membros do workspace.

### Retenção

Regra: manter pelo tempo de vida operacional **mais** a janela de
reconciliação do provedor. Nenhum número fixo — depende do provedor, e
`expires_at` pode vir depois. Sem `ON DELETE CASCADE`: `effect_operations` e
`effect_attempts` referenciam com `RESTRICT`, então apagar a prova de um
efeito exige uma decisão explícita, na ordem histórico → operação →
execução.

**Consequência que precisava de decisão antes da primeira integração real:**
apagar um workflow (cascata para `executions`) ou um workspace que tenha
operação registrada **falha** com violação de FK. *Decidido na Fase 10.5A:*
workflow com histórico de efeito é **arquivado**, não apagado (a API responde
409 `WORKFLOW_HAS_EFFECT_HISTORY` e a UI oferece Arquivar); a purga continua
sendo uma decisão explícita, fora do produto, depois da janela de retenção.
Apagar um **workspace** com histórico de efeito continua falhando por FK — não
há fluxo de exclusão de workspace no produto hoje.

`effect_attempts` é append-only de fato: UPDATE é recusado por trigger.

### Observabilidade

`listEffectOperationsForExecution` (MODELO 1) devolve, por operação: quais
épocas tocaram, estado atual, se o resultado é conhecido (`outcomeKnown`),
a chave usada, a referência do provedor e o histórico em ordem (`seq`, não
`created_at`: dois eventos da mesma transação dividem o mesmo `now()`). Há
índice parcial para achar `unknown` por workspace. *Fase 10.5A:* existem as
rotas `GET /api/effects`, `GET /api/effects/[operationId]` e
`POST /api/effects/[operationId]/resolve` (ver abaixo); **UI de efeitos ainda
não**.

### Validação desta fase

- `tsc --strict` (com `noUncheckedIndexedAccess`) sobre os módulos reais do
  engine e dos efeitos: 0 erros. Na árvore inteira, os únicos erros novos em
  relação à Fase 9 são `drizzle-orm` ausente (npm 403) e seus `any` implícitos
  em cascata — as mesmas duas classes que já existiam.
- Para reproduzir tudo abaixo sem `node_modules`:
  `./scripts/effects-spec/run.sh --types --mutate` (Node), e
  `scripts/f4f-lifecycle-harness.sql` + `scripts/concurrency-check.sh`
  (PostgreSQL; ver os cabeçalhos). `scripts/effects-spec` fica fora do
  `tsconfig` do projeto de propósito: o modelo de tipos declara um módulo
  `drizzle-orm` falso, que não pode vazar para o build.
- Spec executável (`node`) rodando os módulos REAIS compilados — chave,
  decisão, runner, MockExternalEffect, executor mock e `runExecutionPlan` —
  contra um repositório em memória que espelha cada WHERE do SQL e o guard do
  banco: **128 PASS**. Vinte mutações plausíveis (unknown vira retry, adotar
  in_flight como reserved, fato cercado por posse, época na chave, texto de
  exceção gravado, sem prazo, etc.) — **todas detectadas**: 17 por asserção,
  1 porque a spec trava sem o prazo, e 2 recusadas pelo próprio esquema
  (guard e CHECK) mesmo com o código errado.
- `effect-repository.ts` não compila de verdade sem Drizzle; foi checado
  (`--strict`, `noUncheckedIndexedAccess`) contra um modelo de tipos que
  imita o que o Drizzle devolve (arrays de linhas, enums nos inserts). O
  modelo acusou 5 erros reais na primeira versão — `const [row] = ...`
  devolvido onde se exigia linha definida — e 0 depois da correção.
- PostgreSQL 16 limpo: migrations 0000–0006 aplicadas, 0006 reaplicada
  (idempotente); harness seção 8 (transcrição do repositório + provedor
  falso): **76 PASS**, e as seções 1–7 seguem 56 PASS.
- Duas sessões reais (`concurrency-check.sh`, cenário 6 — teste C): reserve
  concorrente cria UMA operação (a segunda sessão espera o commit); begin
  concorrente deixa UM `done` e UM `stale`, e o provedor recebe UMA
  requisição; o reaper ESPERA o `begin` do dono (`FOR SHARE`).
  Controle negativo sem `FOR SHARE`: o reaper devolveu a execução à fila
  em 44 ms com o `begin` ainda aberto, e o `begin` commitou depois de a posse
  ter mudado. A garantia de no-máximo-uma-vez vem do `began_epoch` gravado
  uma vez (lock da linha + guard do banco). O `FOR SHARE` garante outra
  coisa, mais estreita: que a DECISÃO de cruzar o ponto sem volta só é
  tomada por quem é dono naquele instante. Ele **não** impede a chamada de
  acontecer depois de a posse mudar — um worker que trava entre o `begin` e a
  chamada envia quando acorda (ver "Resolução humana é juízo").
- Revisão independente (outro agente, sem ver o raciocínio de quem
  implementou), com PostgreSQL e sessões concorrentes: nenhum envio duplo,
  nenhuma época superada cruzando o `begin`, nenhum deadlock. Achou três
  problemas médios — resolução humana contradizendo o provedor, texto de
  exceção com token sendo gravado, e o trigger de término só cobrindo
  `running` — e sete menores (at-most-once dependia do código e não do banco,
  referência vazia aceita, fato não amarrado à execução, NUL/surrogate
  derrubando um resultado definitivo, unknown espúrio com itens paralelos,
  `failed` sem código aceito, chamada sem prazo). **Todos corrigidos**, cada
  um com teste e mutação correspondentes. A correção trouxe mais um achado,
  pego pelo harness: o CHECK "succeeded tem referência", reescrito como
  `length(...) > 0`, deixava passar referência NULL (CHECK com resultado
  NULL passa) — corrigido com `IS NOT NULL AND`.
- Vitest: `effect-runner.integration.test.ts` escrito (A–K + os sete
  cenários, contra o repositório Drizzle real) e **não executado** — npm
  continua respondendo 403 (reconfirmado nesta fase).

### Limites, ditos com todas as letras

- **Não existe exactly-once.** Com provedor sem chave, o que existe é
  no-máximo-uma-vez, com `unknown` honesto quando não dá para saber.
- As duas transcrições (harness SQL e repositório em memória) validam as
  CONDIÇÕES do repositório, não o código Drizzle em si. O uso de
  `.for("share")` e `.onConflictDoNothing({ target })` não foi conferido
  contra o pacote instalado — `node_modules` segue indisponível. (A revisão
  independente leu o código-fonte do drizzle-orm 0.33 e não achou problema
  nessas chamadas — leitura, não compilação.)
- O `seq` do histórico é bigserial: dá a ordem por operação (todo escritor
  segura o lock da operação), não uma ordem global de commit.
- O estado da execução é o que o dono sabia quando terminou: se um fato
  tardio transformar um `unknown` em `succeeded` depois, a execução continua
  registrada como erro no nó — a verdade sobre o efeito é o registro da
  operação.
- **Janela que nenhuma checagem local fecha:** entre o último instante em
  que o worker pode verificar alguma coisa e os bytes saírem na rede, um
  processo pode travar e acordar depois de superado. O protocolo garante que
  ninguém mais envia (a nova época vê `in_flight` e para) e que a resposta,
  se chegar, é gravada; não garante que a mensagem não saia atrasada — sem
  chave no provedor, esse envio atrasado é o único. Com um provedor que
  aceita chave, uma política futura poderia reenviar na hora com a mesma
  chave e deixar o provedor descartar o envio atrasado (dentro das garantias
  dele); nada disso existe nesta fase.
- A coalescência de itens paralelos vale dentro de um processo; entre
  processos, a barreira é o banco (um `done`, um `stale`).

## Fase 10.5A — arquivar em vez de apagar; resolver `unknown` com evidência

Antes de qualquer integração real, duas coisas precisavam existir: um jeito
de uma pessoa decidir um `unknown` **sem destruir a trilha de auditoria**, e
um destino para workflow que já causou efeito externo (apagar falhava por FK,
de propósito). Esta fase entrega as duas, **ainda sem Mercado Pago** — nenhum
provedor real, nenhum executor novo. A prova com provedor real é a 10.5B.

### O que uma pessoa pode fazer com um `unknown`

O contrato mora em `server/execution/effects/resolution.ts`; o resto só o
executa.

| pode | detalhe |
|---|---|
| **ler** | qualquer membro do workspace: a operação, a execução, o workflow, e todo o histórico em ordem |
| **resolver uma vez** | só `owner`/`admin`, com UMA de três decisões, cada uma presa ao que o **provedor** mostra |
| **só depois** | que a execução terminou (nada mais age em nome dela) **e** 600 s depois do `began` (a própria chamada ainda pode responder), no relógio do banco |

| decisão | vira | exige |
|---|---|---|
| `confirmed_sent` — o provedor tem o efeito | `succeeded` | a referência do provedor (1–256 caracteres imprimíveis, sem espaço nas pontas — aceita como está, nunca "consertada") |
| `confirmed_not_sent` — o provedor não tem registro | `failed` | o que foi consultado e o que mostrou (`evidence.detail`, ≥ 5 caracteres); referência é recusada — não há o que referenciar |
| `confirmed_rejected` — o provedor recebeu e recusou | `failed` | idem; a referência da recusa, se houver, fica só no fato do histórico |

Sempre com `evidence.source` — `provider_api`, `provider_dashboard`,
`provider_webhook` ou `provider_support`: a fonte é o provedor, "acho que
sim" não é fonte — e `justification` (10–1000 caracteres, contados como o
PostgreSQL conta: por caractere, não por unidade UTF-16).

**Não pode:** escolher estado sem evidência; resolver o que não é `unknown`
(desfecho informado pelo provedor é final; `reserved` nunca cruzou o ponto
sem volta); resolver duas vezes ou sobrescrever a decisão de outra pessoa —
nem a própria; editar ou apagar histórico; reenviar daqui.

O que é gravado, numa transação com a operação travada: o novo estado,
`resolved_by_user_id` e `resolution` (quem decidiu e o quê), `last_error`
com `RESOLVED_NOT_SENT`/`RESOLVED_REJECTED` e a justificativa (para
`failed`), e **um** fato `resolved` append-only com decisão, evidência e
justificativa. As recusas não deixam rastro.

### A regra acima de todas

**A pessoa resolve o estado operacional; o provedor informa o fato externo.**
Se a resposta da própria chamada chegar depois da decisão, ela a
**substitui** — conflitante ou não. Quando contradiz ("enviado" → o provedor
diz que recusou), o registro passa a dizer a verdade; quando concorda, o
estado deixa de ser um juízo e passa a ser palavra do provedor
(`resolved_by_user_id` e `resolution` zerados nos dois casos). O fato grava
qual juízo substituiu (`overridesResolution`: estado, decisão, quem), e o
histórico guarda os dois. O que **não** substitui uma decisão: um `unknown`
tardio (não traz informação) e um fato de época que não fez a chamada.
Depois de um fato do provedor, nenhuma decisão humana é aceita.

### Onde cada regra mora

A camada do banco vale para qualquer escritor — script, console, bug
futuro. Onde uma regra só existe numa camada, a tabela diz:

| regra | API (zod) | repositório | banco (0007) |
|---|---|---|---|
| decisão com evidência e justificativa | `resolveEffectRequestSchema` | grava o fato | CHECK `effect_attempts_resolution_has_evidence` (chave ausente recusa; espaços não contam; ator tem de ser pessoa) |
| decisão ↔ estado coerentes | — | `statusForResolution` | CHECK `effect_operations_resolution_matches` |
| a decisão e o seu registro são inseparáveis | — | estado e fato na mesma transação | constraint trigger (no COMMIT) + trigger no fato: nem estado de resolução sem o fato `resolved`, nem fato sem a resolução, nem decisão trocada por "fato do provedor" que não foi gravado |
| só `unknown`; ninguém sobrescreve ninguém | — | `status = 'unknown'` sob `FOR UPDATE` | guard (redefinido na 0007) |
| quando: execução terminou | — | checa | constraint trigger |
| quando: 600 s desde o `began` | — | checa, no relógio do banco | **só aplicação** (os testes precisam variar) |
| quem decide (owner/admin) | — | `RESOLVER_ROLES` | **só aplicação** — a escrita é sempre pelo servidor |
| sem credencial no texto livre | `LOOKS_LIKE_CREDENTIAL` | — | **só API** (melhor esforço) |

O banco protege contra escrita acidental e bug. Quem forja fatos de
propósito, com acesso direto ao banco, está fora do que um banco garante.

### API (sem UI de efeitos nesta fase)

O workspace vem sempre da sessão, nunca do pedido. As respostas passam por
`effect-view.ts`, uma allowlist: sem chave idempotente, sem fingerprint, e o
`detail` do histórico só com chaves conhecidas.

- `GET /api/effects` — por padrão os `unknown`; `?status=all` ou qualquer
  estado; `&limit=1..200` (padrão 50). Cada item traz workflow, estado da
  execução, `beganAt` e `resolvableFrom`.
- `GET /api/effects/[operationId]` — `{ operation, history }`. Id inválido,
  de outro workspace ou inexistente: 404, indistinguíveis.
- `POST /api/effects/[operationId]/resolve`

```json
{
  "resolution": "confirmed_not_sent",
  "evidence": { "source": "provider_dashboard", "detail": "nenhuma mensagem para lead-42 entre 14h e 15h" },
  "justification": "conferi no painel do provedor; a chamada nunca chegou"
}
```

| resposta | quando |
|---|---|
| 200 `{ operation }` | resolvida |
| 400 `VALIDATION_ERROR` | falta evidência, justificativa ou referência; campo extra (o corpo é estrito — `workspaceId`/`userId` no corpo são recusados); texto com cara de credencial |
| 413 `PAYLOAD_TOO_LARGE` | corpo acima de 16 KB (uma resolução legítima tem poucos KB) — recusado antes de ser interpretado |
| 403 `EFFECT_RESOLUTION_FORBIDDEN` | quem pediu não é owner/admin |
| 404 `EFFECT_NOT_FOUND` | |
| 409 `EFFECT_NOT_UNKNOWN` | o desfecho já é conhecido |
| 409 `EFFECT_EXECUTION_ACTIVE` | a execução ainda não terminou |
| 409 `EFFECT_RESOLUTION_TOO_EARLY` | antes do resfriamento; a mensagem diz a partir de quando |

### Arquivar em vez de apagar

- `workflows.archived_at` / `archived_by` (os dois ou nenhum). Ortogonal a
  `status`: arquivar e restaurar não mexem nele.
- **Arquivado:** sai da lista ativa (`GET /api/workflows?archived=true` e a
  aba "Archived" do painel mostram), é somente leitura (PATCH → 409
  `WORKFLOW_ARCHIVED`), não recebe execução (Execute → 409
  `WORKFLOW_ARCHIVED`), mantém execuções, operações e histórico intactos, e
  pode ser restaurado (`POST /api/workflows/[id]/restore`).
- **Arquivar** (`POST /api/workflows/[id]/archive`) é recusado com execução
  do **worker** `queued`/`running` (409 `WORKFLOW_HAS_ACTIVE_EXECUTIONS`):
  nada pode continuar agindo em nome de um workflow arquivado. Execuções
  síncronas não contam: não têm como causar efeito externo, e uma que ficou
  `running` porque a request morreu nunca é recuperada (por desenho) —
  contá-la travaria o arquivamento para sempre (achado da revisão). Uma
  execução do worker na fila é consumida pelo worker; sem o worker rodando,
  nada assíncrono anda. Idempotente. Id que não é UUID: 404.
- **Apagar** só workflow sem histórico de efeito; com histórico, 409
  `WORKFLOW_HAS_EFFECT_HISTORY` — e o diálogo da UI oferece Arquivar no
  lugar. A FK `RESTRICT` continua sendo o backstop da corrida.
- **A corrida "arquivar × executar"** é fechada pelo lock da linha do
  workflow, não por tempo: arquivar trava `FOR UPDATE`; inserir execução lê o
  workflow `FOR SHARE` (trigger da 0007, WK001). Ou a execução nasce antes e
  o arquivamento a encontra, ou o arquivamento vem antes e a inserção é
  recusada. O trigger WK002 recusa arquivar com execução viva para qualquer
  escritor. Provado com duas sessões reais nas duas ordens; sem o `FOR SHARE`
  (controle negativo), nasceu execução para workflow arquivado.
- **Efeitos não ganham `archived_at`.** São prova de algo que aconteceu lá
  fora — imutáveis, fora do ciclo de vida do workflow. Um `unknown` de
  workflow arquivado continua listado e resolvível: arquivar não pode
  esconder uma pendência.

### Não existe nesta fase (decisões tomadas aqui, para revisão)

- **Retry.** Resolver `confirmed_not_sent` não reenvia: o payload não é
  guardado, e uma nova execução tem outra chave. Reenviar com segurança
  depende da capacidade de cada provedor (abaixo) — 10.5B em diante.
- **Maker-checker.** Os workspaces hoje são de um usuário
  (`ensureDefaultWorkspace`), então exigir uma segunda pessoa seria
  inalcançável. Com times, pedir duas pessoas para `confirmed_not_sent` em
  efeito grave (pagamento) é a evolução natural.
- **Corrigir uma resolução.** Só o fato do provedor substitui uma decisão.
  "Corrigir" seria um caminho novo, explícito, com registro próprio — não
  uma segunda resolução por cima.
- **UI de efeitos.** Só a API. A tela vem com a primeira integração real,
  para não inventar UX antes de saber o que o operador precisa ver.
- O editor não mostra aviso de "arquivado"; salvar e executar respondem 409
  com a mensagem.

### Política por capacidade do provedor (para 10.5B em diante)

"Mercado Pago é o melhor primeiro provedor" é uma escolha de teste, não uma
regra de arquitetura. A regra é por capacidade, registrada na ficha de cada
integração:

- o provedor aceita chave idempotente → retry com a mesma chave lógica;
- o provedor permite reconciliação → consultar antes de decidir;
- nenhum dos dois → `unknown` + resolução humana (**o único que existe hoje**:
  o banco só aceita `at_most_once`).

### LGPD como regra de engenharia (não conclusão jurídica)

Trilha de auditoria não é guardar tudo para sempre: é guardar só o
necessário para provar o que aconteceu.

- **Gravado:** ids, estados, códigos, quem decidiu, a justificativa e o que
  foi consultado. **Nunca gravado:** payload (só o hash), headers, tokens,
  cookies, credenciais.
- **Texto que uma pessoa escreve** (justificativa, evidência, referência) é
  recusado quando tem cara de credencial ou de header — cru ou entre aspas,
  como o "Copy as fetch" do navegador escreve: `Authorization:` seguido de
  um esquema (`Basic`, `Bearer`, …), `Cookie:` com `nome=valor`, `Bearer`
  com token, segredo rotulado (`api_key=`, `access_token=`,
  `client_secret=`, `password:`, `senha:`, …), chave privada, JWT, e os
  formatos de token de Mercado Pago, Meta, Google, Stripe, GitHub, Slack e
  AWS. É **melhor esforço**, checado só na API: não pega todo segredo, e
  pode recusar um texto legítimo raro (a pessoa reescreve) —
  "authorization: 004512" (código de autorização de cartão) passa, porque
  sem esquema não é credencial. Dado pessoal não é detectável com
  segurança; o que o segura são os limites de tamanho e a orientação:
  **descreva o que consultou e o que viu (um id, um status, um horário),
  não cole a mensagem, o payload ou dados do cliente.** Prefira id interno a
  telefone/e-mail como `businessKey` (Fase 10).
- **O texto é medido antes de ser varrido.** A revisão independente mediu
  10 s de CPU para validar 128 KB com a primeira versão (o padrão de JWT
  retrocede quadraticamente, e o zod roda todas as regras mesmo depois de
  uma falhar). Agora o comprimento é checado primeiro e nada varre texto
  acima do limite; o corpo acima de 16 KB é recusado antes do parse.
- **Por que barrar na escrita:** o fato `resolved` é append-only. Um segredo
  colado ali só sai purgando o histórico da operação.
- **Retenção:** o histórico vive enquanto o workflow existe — arquivado
  inclusive. Purga é decisão explícita, fora do produto, na ordem histórico →
  operação → execução, depois da janela de reconciliação do provedor (da
  ficha). Não há purga automática.

### Validação desta fase

- **PostgreSQL 16, bancos limpos**, migrations 0000–0007 (0007 reaplicada:
  idempotente). Harness: seções 1–7 **56 PASS**, seção 8 **79 PASS**
  (transcrição de resolução atualizada para o modelo novo), seção 9 **78
  PASS** — arquivar/restaurar/editar/apagar, triggers WK001/WK002, os CHECKs
  de evidência (inclusive chave ausente, que a versão anterior deixava
  passar) e de coerência, o guard (pessoa sobre pessoa, pessoa sobre
  provedor), a amarração entre a decisão e o seu registro (item 6 da 0007,
  checado como o COMMIT checa), o fato do provedor por cima da decisão, e o
  resfriamento no relógio do banco (com espera real entre transações).
- **Duas sessões reais** (`concurrency-check.sh`): cenários 1–6 seguem **23
  PASS**; novos: 7a/7b arquivar × executar nas duas ordens, 7c o backstop
  WK002 sob corrida, 8 duas pessoas resolvendo o mesmo `unknown` (uma
  resolve, a outra espera e encontra decidido; um único fato `resolved`), 9a/9b
  resolução × resposta tardia do provedor nas duas ordens (converge para o
  fato do provedor) — **14 PASS**.
- **Controles negativos no banco:** catorze mutações (doze da 0007, duas da
  0008) (sem o trigger de
  inserção, sem o WK002, sem o `FOR SHARE`, sem cada CHECK, a CHECK de
  evidência sem o `coalesce`, o guard antigo, sem cada um dos dois triggers
  do item 6, o WK002 contando execução síncrona, e o fato do provedor sem
  zerar `resolution`) — **todas acusadas**. A sem `FOR SHARE` passa no
  harness sequencial e só as duas sessões pegam.
- **Node** (`scripts/effects-spec/run.sh --mutate --types --routes --routes-mutate`):
  spec com os módulos reais, incluindo `resolution.ts` (zod) e
  `effect-view.ts` — **182 PASS**; **41/41** mutações detectadas (20 da Fase 10
  + 21 novas); as **rotas reais** de `/api/effects` e de workflows, com
  Next/sessão/repositórios em stub — **34 PASS**, **14/14** mutações
  detectadas; `effect-repository.ts` e `server/workflows` contra o modelo de
  tipos do Drizzle — **0 erros**, e **13/13** erros de tipo plantados
  acusados. (Com os dois débitos de infraestrutura corrigidos depois: rotas
  **42 PASS** com **16/16** mutações, e harness **219 PASS** com a seção 10.)
- **Revisão independente** (outro agente, sem ver o raciocínio de quem
  implementou, com PostgreSQL e sessões concorrentes): as garantias
  principais aguentaram — arquivar × executar nas duas ordens, duas pessoas
  resolvendo, resolução × fato tardio, e ~800 transações de sete sessões
  misturadas sem um deadlock. Achou quatro problemas reais, **todos
  corrigidos, cada um com teste e controle negativo**: (1) o validador podia
  gastar minutos de CPU com um corpo grande (padrão de JWT retrocedendo, e o
  zod rodando todas as regras mesmo depois de uma falhar) — agora o tamanho
  vem primeiro e o corpo tem teto; (2) a CHECK de evidência deixava passar
  um `resolved` sem decisão e sem fonte, porque `NULL IN (...)` é NULL e uma
  CHECK NULL passa — agora `coalesce(..., false)`, com ator e espaços
  checados; (3) nada amarrava as colunas de resolução ao histórico: uma
  escrita direta podia marcar resolvido sem fato, ou "lavar" a decisão de
  uma pessoa num estado que parecia do provedor — agora os dois triggers do
  item 6; (4) uma execução síncrona presa em `running` travava o
  arquivamento para sempre. Além desses, três menores: o diálogo de apagar
  na aba de arquivados não oferecia saída, arquivar/restaurar com id que não
  é UUID devolvia 500, e a lista de credenciais tinha buracos e um falso
  positivo ("authorization: 004512") — corrigidos também. Ficaram de fora,
  documentados abaixo: a paginação da lista e a recursão de RLS (0000).
- `tsc` na árvore inteira: só `TS2307`/`TS7006` novos (pacotes ausentes),
  as mesmas classes de antes.
- **Vitest** (`effect-resolution.integration.test.ts`,
  `workflow-archive.integration.test.ts`, o caso novo em
  `execute/route.test.ts`) escritos e **não executados**: npm responde 403.
- Rodado com zod **3.25.76** (o único disponível aqui); o projeto fixa
  3.23.8 — a API usada é a mesma.

### Limites, ditos com todas as letras

- As transcrições (harness e repositório em memória) validam as condições do
  repositório, não o SQL que o Drizzle gera — `node_modules` segue
  indisponível. As consultas novas com `sql` cru (`beganAt`, o resfriamento)
  só foram exercidas pela transcrição.
- O resfriamento cobre a resposta da CHAMADA. Confirmações que o provedor
  manda depois por conta própria (webhooks) são por integração, na ficha.
- A guarda de credencial é heurística e estreita; não detecta dado pessoal.
- **A lista não pagina.** `GET /api/effects` devolve no máximo 200, dos mais
  recentes para os mais antigos. Com mais de 200 `unknown` pendentes, os
  mais antigos só aparecem depois que os mais novos forem resolvidos. Um
  cursor por `(updated_at, id)` resolve; não entrou nesta fase.
- Os dois achados pré-existentes (slugs irmãos e RLS recursiva) foram
  corrigidos como infraestrutura, fora da 10.5A — abaixo.

## Dois débitos de infraestrutura (fora da 10.5A)

Nenhum dos dois é da Fase 10.5A; os dois apareceram na revisão dela e foram
corrigidos em seguida, separados de propósito.

### 1. Segmentos dinâmicos irmãos com nomes diferentes

`app/api/workflows/[id]/` e `app/api/workflows/[workflowId]/execute/`
descrevem o MESMO segmento dinâmico com dois nomes, o que o Next.js recusa
no build ("You cannot use different slug names for the same dynamic path") —
e a 10.5A acrescentou mais rotas sob `[id]`, então ficava pior. O executar
mudou de arquivo para `app/api/workflows/[id]/execute/route.ts` e
`params.workflowId` virou `params.id`; **a URL pública é a mesma**
(`POST /api/workflows/<id>/execute`), o corpo e as respostas também.
Validado: a rota real, compilada, passa a estar na bateria de rotas
(`scripts/effects-spec/routes`) — 8 casos novos, incluindo os 409
`WORKFLOW_ARCHIVED` nos dois modos, o `workspaceId` do corpo sendo ignorado
e o 202 do assíncrono; duas mutações novas, as duas mortas. (O build do
Next continua não sendo executável aqui — sem `node_modules`.)

### 2. RLS recursiva (migration `0008_rls_without_recursion.sql`)

Toda policy de leitura pergunta "quem está lendo é membro deste workspace?"
lendo `workspace_members` — e a policy de `workspace_members` fazia essa
pergunta sobre ela mesma (0000). Resultado: qualquer leitura por um papel
sujeito a RLS morria com "infinite recursion detected in policy for relation
workspace_members". Fechava em vez de vazar, e não afetava o produto (a
aplicação conecta pela própria `DATABASE_URL`, fora do RLS, e a autorização
real é `requireWorkspaceMembership`) — mas deixava inútil a barreira que
precisa existir antes de o produto virar multi-tenant de verdade.

A 0008 cria `public.is_workspace_member(uuid)` — `SECURITY DEFINER`,
`STABLE`, `search_path` fixo — e reescreve as sete policies de leitura para
chamá-la. O que cada uma permite não muda, e continua não existindo policy
de escrita.

Validado na seção 10 do harness, que roda como um papel comum (o
equivalente ao `authenticated` do Supabase), não como dono das tabelas:
o membro lê exatamente as linhas do workspace dele nas sete tabelas, quem
não é membro lê zero, e nenhuma leitura recursa. Dois controles negativos:
com a policy recursiva de volta, e com a função sem `SECURITY DEFINER` —
os dois acusam (recursão / estouro de pilha).
