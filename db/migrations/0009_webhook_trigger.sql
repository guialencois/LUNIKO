-- Fase 5A: Webhook Trigger. Ver docs/webhook-trigger.md.
-- Nova migration — 0000..0008 não são modificadas.

-- ---------------------------------------------------------------------
-- executions: uma execução pode começar por um webhook
-- ---------------------------------------------------------------------

-- O CHECK de 0002 foi declarado inline, então o Postgres o chamou de
-- executions_trigger_type_check.
ALTER TABLE "executions" DROP CONSTRAINT IF EXISTS "executions_trigger_type_check";
ALTER TABLE "executions"
  ADD CONSTRAINT "executions_trigger_type_check"
  CHECK ("trigger_type" IN ('manual', 'webhook'));

-- De qual nó a execução começa. NULL nas execuções manuais (o planner acha
-- o manualTrigger sozinho, como sempre fez).
ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "trigger_node_id" text;
-- A entrada do trigger: { "items": [ { "json": {...} }, ... ] }.
ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "trigger_payload" jsonb;
-- Identidade de um disparo que pode chegar repetido (reenvio da Meta).
ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "trigger_dedupe_key" text;

CREATE UNIQUE INDEX IF NOT EXISTS "executions_trigger_dedupe_key_unique"
  ON "executions" ("trigger_dedupe_key")
  WHERE "trigger_dedupe_key" IS NOT NULL;

-- Um disparo por webhook sempre sabe de onde começa, e sempre vai para a
-- fila: o caminho síncrono não tem recuperação, e quem chama um webhook não
-- espera o workflow terminar.
ALTER TABLE "executions" DROP CONSTRAINT IF EXISTS "executions_webhook_shape_check";
ALTER TABLE "executions"
  ADD CONSTRAINT "executions_webhook_shape_check"
  CHECK (
    "trigger_type" <> 'webhook'
    OR ("trigger_node_id" IS NOT NULL AND "runner" = 'worker')
  );

-- ---------------------------------------------------------------------
-- webhook_endpoints: a URL pública de um nó webhookTrigger
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "node_id" text NOT NULL,

  -- A credencial: quem tem a URL dispara o workflow. 32 bytes aleatórios
  -- em base64url (43 caracteres).
  "token" text NOT NULL CHECK (length("token") >= 40),

  -- Quem gerou a URL. Vira executions.created_by de cada disparo.
  "created_by" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "webhook_endpoints_token_unique" UNIQUE ("token"),
  CONSTRAINT "webhook_endpoints_workflow_node_unique" UNIQUE ("workflow_id", "node_id")
);

CREATE INDEX IF NOT EXISTS "webhook_endpoints_workspace_idx"
  ON "webhook_endpoints" ("workspace_id");

-- Mesmo padrão de 0008: leitura para membro do workspace, nenhuma policy de
-- escrita (escrita só pela conexão da aplicação, autorizada em código).
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhook_endpoints_select_member" ON "webhook_endpoints";
CREATE POLICY "webhook_endpoints_select_member" ON "webhook_endpoints"
  FOR SELECT USING ("public"."is_workspace_member"("workspace_id"));
