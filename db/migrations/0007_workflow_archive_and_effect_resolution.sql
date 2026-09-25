-- Fase 10.5A: arquivar workflows e resolver operações "unknown" com evidência.
-- Nova migration — 0000..0006 não são modificadas. A função do guard de
-- effect_operations (criada em 0006) é redefinida aqui com CREATE OR
-- REPLACE, porque uma regra dela muda (item 5).
--
-- Nada aqui apaga ou reescreve histórico. As restrições novas sobre linhas
-- antigas entram como NOT VALID: valem para toda escrita daqui em diante,
-- sem reprovar o que já existia antes delas.

-- ---------------------------------------------------------------------
-- 1. Workflow arquivado
--
-- Arquivar é o destino de um workflow que tem histórico de efeito externo:
-- esse histórico é prova de algo que aconteceu fora do sistema e não pode
-- sumir em cascata (0006, RESTRICT). Um workflow arquivado:
--   - não aparece na lista ativa;
--   - não recebe execução nova (item 2, pelo banco);
--   - não é editado (a aplicação recusa; ver server/workflows/mutations.ts);
--   - mantém executions, effect_operations e effect_attempts intactos;
--   - pode ser restaurado.
-- É ortogonal a `status` (draft/active/inactive): arquivar não mexe nele.
-- ---------------------------------------------------------------------
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz;
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "archived_by" uuid;

DO $$ BEGIN
  ALTER TABLE "workflows" ADD CONSTRAINT "workflows_archived_pair"
    CHECK (("archived_at" IS NULL) = ("archived_by" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- 2. Arquivado não recebe execução nova — e não se arquiva com execução viva
--
-- Duas regras, garantidas pelo banco e não só pelos serviços, porque as duas
-- são uma corrida: alguém clica Execute no mesmo instante em que outra
-- pessoa arquiva.
--
--   inserir execução  lê o workflow FOR SHARE e recusa se estiver arquivado
--   arquivar          (UPDATE, que trava a linha) recusa se houver execução
--                     do WORKER queued ou running
--
-- Só as do worker bloqueiam: são as únicas que podem causar efeito externo
-- (o caminho síncrono falha com EXTERNAL_EFFECTS_UNAVAILABLE) e as únicas que
-- o reaper recupera. Uma execução síncrona que ficou "running" para sempre
-- (a request morreu no meio — não há recuperação para elas, por desenho)
-- travaria o arquivamento para sempre.
--
-- O lock da linha do workflow serializa as duas: ou a execução nasce antes
-- (e o arquivamento a encontra e recusa), ou o arquivamento vem antes (e a
-- inserção falha). Nunca as duas. Erros com SQLSTATE próprio para a
-- aplicação distinguir: WK001 (arquivado) e WK002 (execução em andamento).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "executions_refuse_archived_workflow"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE archived timestamptz;
BEGIN
  SELECT "archived_at" INTO archived FROM "workflows" WHERE "id" = NEW."workflow_id" FOR SHARE;
  -- Workflow inexistente: deixa a FK responder com o erro dela.
  IF FOUND AND archived IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WK001',
      MESSAGE = 'workflow is archived: it cannot receive new executions';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "executions_refuse_archived_workflow" ON "executions";
CREATE TRIGGER "executions_refuse_archived_workflow"
  BEFORE INSERT ON "executions"
  FOR EACH ROW EXECUTE FUNCTION "executions_refuse_archived_workflow"();

CREATE OR REPLACE FUNCTION "workflows_refuse_archive_with_active_executions"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."archived_at" IS NULL AND NEW."archived_at" IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM "executions"
        WHERE "workflow_id" = NEW."id" AND "runner" = 'worker' AND "status" IN ('queued', 'running')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WK002',
      MESSAGE = 'workflow has queued or running worker executions: it cannot be archived now';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "workflows_refuse_archive_with_active_executions" ON "workflows";
CREATE TRIGGER "workflows_refuse_archive_with_active_executions"
  BEFORE UPDATE OF "archived_at" ON "workflows"
  FOR EACH ROW EXECUTE FUNCTION "workflows_refuse_archive_with_active_executions"();

-- ---------------------------------------------------------------------
-- 3. O que uma pessoa decidiu sobre um "unknown"
--
--   confirmed_sent      o provedor tem o efeito        -> succeeded
--   confirmed_not_sent  o provedor não tem registro    -> failed
--                       (nada aconteceu lá fora; refazer seria seguro)
--   confirmed_rejected  o provedor recebeu e recusou   -> failed
--                       (refazer igual falharia de novo)
--
-- `resolution` existe exatamente quando uma pessoa decidiu o estado
-- (resolved_by_user_id); um fato do provedor que chegue depois zera os dois.
-- ---------------------------------------------------------------------
ALTER TABLE "effect_operations" ADD COLUMN IF NOT EXISTS "resolution" text;

DO $$ BEGIN
  ALTER TABLE "effect_operations" ADD CONSTRAINT "effect_operations_resolution_matches"
    CHECK (
      ("resolution" IS NULL) = ("resolved_by_user_id" IS NULL)
      AND (
        "resolution" IS NULL
        OR ("resolution" = 'confirmed_sent' AND "status" = 'succeeded')
        OR ("resolution" IN ('confirmed_not_sent', 'confirmed_rejected') AND "status" = 'failed')
      )
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- 4. Resolução sem evidência não existe
--
-- O evento `resolved` do histórico carrega, sempre: a decisão, a fonte da
-- evidência — que é o PROVEDOR (API, painel, webhook, suporte), nunca "achei
-- que sim" —, o que foi consultado quando a decisão diz que nada aconteceu,
-- e a justificativa. Garantido aqui, não só pela API: nenhum caminho grava
-- uma resolução sem isso.
-- ---------------------------------------------------------------------
-- Tudo dentro de coalesce(..., false): numa CHECK, resultado NULL PASSA, e
-- `NULL IN (...)` é NULL — uma chave ausente no jsonb deixaria passar um
-- `resolved` sem decisão ou sem fonte (a mesma armadilha anotada na 0006).
-- Espaços não contam: btrim antes de medir.
DO $$ BEGIN
  ALTER TABLE "effect_attempts" ADD CONSTRAINT "effect_attempts_resolution_has_evidence"
    CHECK (
      "event" <> 'resolved'
      OR coalesce(
        "actor" = 'user'
        AND "from_status" = 'unknown'
        AND ("detail" ->> 'resolution') IN ('confirmed_sent', 'confirmed_not_sent', 'confirmed_rejected')
        AND length(btrim("detail" ->> 'justification')) >= 10
        AND ("detail" -> 'evidence' ->> 'source')
              IN ('provider_api', 'provider_dashboard', 'provider_webhook', 'provider_support')
        AND CASE WHEN ("detail" ->> 'resolution') = 'confirmed_sent'
                 THEN length("provider_reference") > 0
                 ELSE length(btrim("detail" -> 'evidence' ->> 'detail')) >= 5
            END,
        false)
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- 5. O guard de 0006, com uma regra mais estreita
--
-- Antes: um estado final decidido por pessoa podia ser trocado por qualquer
-- escrita. Agora: só por um FATO do provedor (que zera resolved_by_user_id e
-- resolution). Uma pessoa não sobrescreve a resolução de outra — corrigir
-- uma resolução, se um dia existir, será um caminho próprio e explícito.
-- O resto do guard é o de 0006, sem mudança.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "effect_operations_guard_transitions"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."execution_id" <> OLD."execution_id" OR NEW."workspace_id" <> OLD."workspace_id"
     OR NEW."node_id" <> OLD."node_id" OR NEW."business_key" <> OLD."business_key"
     OR NEW."operation" <> OLD."operation" OR NEW."idempotency_key" <> OLD."idempotency_key"
     OR NEW."payload_fingerprint" <> OLD."payload_fingerprint"
     OR NEW."delivery_policy" <> OLD."delivery_policy" THEN
    RAISE EXCEPTION 'effect_operations: the identity of an operation is immutable';
  END IF;

  IF OLD."began_epoch" IS NOT NULL AND NEW."began_epoch" IS DISTINCT FROM OLD."began_epoch" THEN
    RAISE EXCEPTION 'effect_operations: began_epoch is written once';
  END IF;

  IF NEW."owner_epoch" < OLD."owner_epoch" THEN
    RAISE EXCEPTION 'effect_operations: owner_epoch never decreases';
  END IF;

  IF OLD."resolved_by_user_id" IS NULL AND NEW."resolved_by_user_id" IS NOT NULL
     AND OLD."status" <> 'unknown' THEN
    RAISE EXCEPTION 'effect_operations: only an unknown operation can be resolved by a person';
  END IF;

  IF NOT (
       (OLD."status" = 'reserved'  AND NEW."status" IN ('reserved', 'in_flight'))
    OR (OLD."status" = 'in_flight' AND NEW."status" IN ('in_flight', 'unknown', 'succeeded', 'failed'))
    OR (OLD."status" = 'unknown'   AND NEW."status" IN ('unknown', 'succeeded', 'failed'))
    OR (OLD."status" IN ('succeeded', 'failed') AND NEW."status" IN ('succeeded', 'failed')
        AND (
          -- nada muda no desfecho
          (NEW."status" = OLD."status"
           AND NEW."provider_reference" IS NOT DISTINCT FROM OLD."provider_reference"
           AND NEW."last_error" IS NOT DISTINCT FROM OLD."last_error"
           AND NEW."resolved_by_user_id" IS NOT DISTINCT FROM OLD."resolved_by_user_id"
           AND NEW."resolution" IS NOT DISTINCT FROM OLD."resolution")
          -- ou um fato do provedor substitui o juízo de uma pessoa
          OR (OLD."resolved_by_user_id" IS NOT NULL AND NEW."resolved_by_user_id" IS NULL)
        ))
  ) THEN
    RAISE EXCEPTION 'effect_operations: transition % -> % is not allowed', OLD."status", NEW."status";
  END IF;

  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- 6. A decisão de uma pessoa e o seu registro são inseparáveis
--
-- Os CHECKs acima olham uma linha de cada vez; nada neles amarra o estado
-- da operação ao histórico. Sem isto, uma escrita direta poderia: marcar a
-- operação como resolvida sem fato `resolved` nenhum (sem evidência, com a
-- execução ainda viva); "lavar" a decisão de uma pessoa num estado que
-- parece do provedor, sem fato do provedor; ou gravar um `resolved` que não
-- corresponde a resolução nenhuma. Duas regras, para qualquer escritor:
--
--   a. resolved_by_user_id passa de NULL a alguém  => nesta MESMA transação
--      existe o fato `resolved` dessa pessoa, com essa decisão e esse estado,
--      e a execução já terminou;
--   b. resolved_by_user_id volta a NULL           => nesta MESMA transação
--      existe o fato do provedor (worker, aplicado) que a substituiu
--      (`overridesResolution`);
--   c. um fato `resolved` só entra se a operação, naquele instante, mostra
--      exatamente a resolução que ele registra.
--
-- (a) e (b) são checadas no COMMIT (constraint trigger DEFERRED), porque o
-- fato é gravado depois da mudança de estado; "nesta transação" = gravado
-- com o now() desta transação. (c) é imediata. O resfriamento (600 s) NÃO
-- está aqui: é da aplicação (resolution.ts), onde os testes podem variá-lo.
-- Isto protege contra escrita acidental e bug; quem forja fatos de
-- propósito com acesso direto ao banco está fora do que um banco garante.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "effect_operations_resolution_is_recorded"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE ex_status text;
BEGIN
  IF OLD."resolved_by_user_id" IS NULL AND NEW."resolved_by_user_id" IS NOT NULL THEN
    PERFORM 1 FROM "effect_attempts" a
     WHERE a."operation_id" = NEW."id" AND a."event" = 'resolved' AND a."actor" = 'user'
       AND a."actor_user_id" = NEW."resolved_by_user_id" AND a."to_status" = NEW."status"
       AND a."detail" ->> 'resolution' = NEW."resolution"
       AND a."created_at" = now();
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'WK003',
        MESSAGE = 'effect_operations: a person''s resolution must be recorded as a resolved fact in the same transaction';
    END IF;
    SELECT "status" INTO ex_status FROM "executions" WHERE "id" = NEW."execution_id";
    IF ex_status IS NULL OR ex_status NOT IN ('success', 'error', 'cancelled') THEN
      RAISE EXCEPTION USING ERRCODE = 'WK003',
        MESSAGE = 'effect_operations: an operation is resolved by a person only after its execution has ended';
    END IF;
  ELSIF OLD."resolved_by_user_id" IS NOT NULL AND NEW."resolved_by_user_id" IS NULL THEN
    PERFORM 1 FROM "effect_attempts" a
     WHERE a."operation_id" = NEW."id" AND a."actor" = 'worker' AND a."applied"
       AND a."event" IN ('succeeded', 'failed') AND a."to_status" = NEW."status"
       AND a."detail" ? 'overridesResolution'
       AND a."created_at" = now();
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'WK003',
        MESSAGE = 'effect_operations: a person''s resolution is replaced only by a recorded provider fact';
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "effect_operations_resolution_is_recorded" ON "effect_operations";
CREATE CONSTRAINT TRIGGER "effect_operations_resolution_is_recorded"
  AFTER UPDATE OF "resolved_by_user_id" ON "effect_operations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."resolved_by_user_id" IS DISTINCT FROM NEW."resolved_by_user_id")
  EXECUTE FUNCTION "effect_operations_resolution_is_recorded"();

CREATE OR REPLACE FUNCTION "effect_attempts_resolved_matches_operation"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE cur "effect_operations"%ROWTYPE;
BEGIN
  SELECT * INTO cur FROM "effect_operations" WHERE "id" = NEW."operation_id";
  IF NOT FOUND
     OR cur."resolved_by_user_id" IS DISTINCT FROM NEW."actor_user_id"
     OR cur."resolution" IS DISTINCT FROM (NEW."detail" ->> 'resolution')
     OR cur."status" IS DISTINCT FROM NEW."to_status" THEN
    RAISE EXCEPTION USING ERRCODE = 'WK003',
      MESSAGE = 'effect_attempts: a resolved fact must record the resolution the operation shows';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "effect_attempts_resolved_matches_operation" ON "effect_attempts";
CREATE TRIGGER "effect_attempts_resolved_matches_operation"
  AFTER INSERT ON "effect_attempts"
  FOR EACH ROW
  WHEN (NEW."event" = 'resolved')
  EXECUTE FUNCTION "effect_attempts_resolved_matches_operation"();
