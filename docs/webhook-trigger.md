# Webhook Trigger (Fase 5A)

Leia isto antes de mexer em `app/api/hooks/*`, `server/webhooks/*` ou no
executor do `webhookTrigger`.

## O que muda

Até a Fase 4, um workflow só começava pelo botão Execute (`manualTrigger`).
O nó **Webhook Trigger** existia no editor, mas o motor respondia
`NOT_IMPLEMENTED`. A partir daqui, um workflow pode começar quando alguém de
fora chama uma URL — e o que acontece depois é o próprio workflow, visível e
editável no editor. Nada de integração fixa no código.

O primeiro uso é o WhatsApp (Meta Cloud API), mas o trigger é genérico:
qualquer serviço que mande um HTTP request pode disparar um workflow.

## Fluxo

```
serviço externo ──HTTP──► /api/hooks/<token>
                            │ 1. acha o endpoint pelo token
                            │ 2. carrega o workflow ATUAL e o nó webhookTrigger
                            │ 3. provider = whatsapp? → desafio (GET) / assinatura (POST)
                            │ 4. monta os items de entrada
                            │ 5. valida o plano (buildExecutionPlan com esse trigger)
                            │ 6. INSERT executions (queued, runner=worker, trigger_type=webhook)
                            ▼
                         200 imediato
                            ⋮
             worker (Supabase Cron → /api/internal/worker) faz o claim
                            │ planner com trigger_node_id da linha
                            │ initialInput = trigger_payload.items
                            ▼
                 o resto do workflow roda como qualquer outro
```

### Por que sempre pela fila, nunca síncrono

- A Meta (e a maioria dos serviços) espera resposta em poucos segundos e
  **reenvia** quando não recebe. Rodar o workflow dentro da request faria
  um workflow lento virar uma tempestade de reenvios.
- A fila já tem tudo que um disparo externo precisa: lease, fencing,
  retry, reaper e efeitos externos com idempotência (Fase 10). O caminho
  síncrono não tem recuperação nenhuma.

## Decisões

### A URL é um token, não o id do workflow

`webhook_endpoints.token` são 32 bytes aleatórios em base64url. O token é a
credencial: quem não tem a URL não dispara nada. O id do workflow aparece em
URLs do dashboard e em logs, então não serve como segredo.

Um endpoint pertence a exatamente um par (workflow, nó). Ele é criado pelo
botão **Gerar URL** no painel do nó — nunca automaticamente ao salvar.

### O workspace vem do banco, nunca da request

É o mesmo princípio do Modelo 2 (`docs/async-execution.md`): o workspace e o
workflow saem da linha de `webhook_endpoints`. Nada que chega na request
escolhe onde o workflow roda.

`executions.created_by` é obrigatório. Para uma execução disparada por
webhook ele é `webhook_endpoints.created_by` — quem gerou a URL. Se essa
pessoa deixou de ser membro do workspace, o endpoint para de funcionar
(404): uma URL não pode sobreviver ao acesso de quem a criou.

### O documento é o do momento em que o request chega

Igual ao Execute: o snapshot é tirado na hora do disparo e guardado em
`executions.document`. Editar o workflow depois não muda uma execução já
enfileirada. Se o documento atual não tem mais o nó do endpoint, ou o nó não
é mais um `webhookTrigger`, a resposta é 404.

Se o workflow for inválido (ciclo, nó desconhecido...), a resposta é 422 e
nada é enfileirado.

### Provider: `generic` ou `whatsapp`

Configurado no próprio nó (`config.provider`).

**generic** — aceita só o método configurado (`config.method`; outro método
→ 405). Gera **um** item:

```json
{ "method": "POST", "query": {...}, "headers": {...}, "body": <JSON ou texto> }
```

Cabeçalhos sensíveis (`authorization`, `cookie`...) são removidos antes de
entrar no item — a mesma lista de `lib/workflows/redaction.ts`.

**whatsapp** — o protocolo da Meta, tratado ANTES de qualquer workflow:

- `GET` com `hub.mode=subscribe` → compara `hub.verify_token` com
  `WHATSAPP_VERIFY_TOKEN` e devolve `hub.challenge`. Não cria execução.
- `POST` → confere `X-Hub-Signature-256` (HMAC-SHA256 do corpo bruto com
  `WHATSAPP_APP_SECRET`). Assinatura inválida → 401, nada roda.
- Gera **um item por mensagem recebida** (texto, remetente, nome, tipo,
  horário e o objeto original em `raw`). Um POST só com `statuses`
  (entregue, lida) → 200 sem execução.
- Reenvio da Meta: `executions.trigger_dedupe_key` = `whatsapp:` + sha256 do
  corpo, com índice único. O mesmo corpo entregue duas vezes vira uma
  execução só.

A conferência de assinatura não pode ser um nó do workflow: se ela falhar,
nada do workflow pode rodar — nem o primeiro nó.

Os segredos da Meta ficam em variável de ambiente, não no banco: uma
implantação do LUNIKO usa um app da Meta. Quando precisar de vários, eles
passam para uma tabela de credenciais cifrada (com `ENCRYPTION_KEY`).

### Limites

- Corpo acima de 1 MB → 413.
- Itens de entrada seguem `EXECUTION_LIMITS.MAX_ITEMS_PER_NODE`.

## Banco (0009_webhook_trigger.sql)

- `executions.trigger_type` passa a aceitar `'webhook'`.
- `executions.trigger_node_id` — de qual nó a execução começa.
- `executions.trigger_payload` — `{ "items": [...] }`, a entrada do trigger.
- `executions.trigger_dedupe_key` — único quando não nulo.
- CHECK: `trigger_type = 'webhook'` exige `trigger_node_id` e `runner = 'worker'`.
- `webhook_endpoints` — token, workflow, nó, quem criou; RLS de leitura
  para membro do workspace, como as outras tabelas.

## Onde ficam as mensagens recebidas

Cada disparo é uma execução, e a entrada dele fica em
`executions.trigger_payload`. Para ler as mensagens do WhatsApp que chegaram:

```sql
select created_at, item->'json'->>'contactName' as nome,
       item->'json'->>'text' as texto
from executions, jsonb_array_elements(trigger_payload->'items') item
where trigger_type = 'webhook'
order by created_at desc;
```

Guardar em outro lugar (uma tabela própria, o CRM, a JUDITE) é trabalho de
um nó do workflow — não do trigger.

## O que fica para depois

- Nó para gravar no banco / responder no WhatsApp (o `httpRequest` ainda é
  `NOT_IMPLEMENTED`).
- Responder ao chamador com o resultado do workflow (modo "esperar
  resposta" do n8n). Hoje a resposta é sempre imediata.
- Rotacionar ou desativar a URL pela interface.
- Disparar o worker na hora em vez de esperar o próximo ciclo do cron.

## Checar antes de configurar na Meta

A URL de produção da Vercel precisa responder sem a proteção de deployment
(Vercel Authentication). O cron usa `x-vercel-protection-bypass`; a Meta não
tem como mandar esse cabeçalho.
