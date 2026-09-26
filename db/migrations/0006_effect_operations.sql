-- Fase 10: registro durável de operações externas.
-- Nova migration — 0000..0005 não são modificadas.
--
-- O QUE ISTO É, E O QUE NÃO É
-- `effect_operations` não é "a tabela de idempotência". É o registro
-- durável de uma operação que este sistema tenta realizar FORA dele —
-- mandar uma mensagem, criar uma cobrança. A chave idempotente é uma
-- propriedade dessa operação, não a operação em si.
--
-- Fencing garante que só o worker/época válido grava o resultado de uma
-- EXECUÇÃO. Não garante que um efeito externo aconteceu uma vez só. O lease
-- também não. Esta tabela existe para tratar exatamente esse buraco — e
-- para registrar com honestidade quando ele não tem como ser fechado.
--
-- UMA UNIQUE NÃO DESFAZ UM POST JÁ ENVIADO. Ela impede que duas operações
-- lógicas sejam criadas para a mesma identidade. Só isso. Quem impede o
-- segundo envio é o protocolo abaixo — reservar, cruzar o ponto sem volta
-- uma única vez, e nunca mais depois disso.

CREATE TABLE IF NOT EXISTS "effect_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Sem CASCADE, de propósito. A prova de que algo aconteceu fora do
  -- sistema não pode desaparecer porque uma execução ou um workspace foi
  -- apagado: apagar isso exige uma decisão explícita, e o banco obriga a
  -- que ela seja tomada (RESTRICT) em vez de fazê-la em silêncio.
  "execution_id" uuid NOT NULL REFERENCES "executions"("id") ON DELETE RESTRICT,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE RESTRICT,

  -- Identidade lógica: (execution, node, entidade de negócio, operação).
  "node_id" text NOT NULL,
  "business_key" text NOT NULL CHECK (length("business_key") BETWEEN 1 AND 256),
  "operation" text NOT NULL CHECK (length("operation") BETWEEN 1 AND 128),
  "idempotency_key" text NOT NULL,

  "delivery_policy" text NOT NULL DEFAULT 'at_most_once'
    CHECK ("delivery_policy" IN ('at_most_once')),

  -- Hash do payload NÃO-secreto. O payload em si nunca é guardado.
  "payload_fingerprint" text NOT NULL,

  "status" text NOT NULL
    CHECK ("status" IN ('reserved', 'in_flight', 'succeeded', 'failed', 'unknown')),

  -- Quem pode TOMAR DECISÕES sobre esta operação agora. Só cresce.
  "owner_epoch" integer NOT NULL CHECK ("owner_epoch" > 0),

  -- A única época que cruzou o ponto sem volta. Gravada uma vez, nunca
  -- limpa: é o que torna "no máximo uma vez" uma propriedade do banco, e é
  -- também quem pode relatar FATOS sobre a chamada.
  "began_epoch" integer,

  -- Referência NÃO-secreta do provedor (id de mensagem, id de pagamento).
  "provider_reference" text,
  "last_error" jsonb,

  -- Quem decidiu o estado final, quando foi uma PESSOA (resolução de um
  -- unknown). NULL quando o estado veio do provedor. Uma resolução é um
  -- juízo; a resposta do provedor é evidência — um fato da época que fez a
  -- chamada, chegando depois, substitui o juízo (ver recordEffectOutcome).
  "resolved_by_user_id" uuid,

  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),

  -- A barreira de concorrência. Não é um índice de desempenho.
  CONSTRAINT "effect_operations_idempotency_key_unique" UNIQUE ("idempotency_key"),

  -- "Reservado" é exatamente "ninguém cruzou o ponto sem volta".
  CONSTRAINT "effect_operations_began_iff_not_reserved" CHECK (
    ("status" = 'reserved') = ("began_epoch" IS NULL)
  ),

  -- Quem começou a chamada era dono dela naquele momento, e a posse só
  -- cresce depois disso.
  CONSTRAINT "effect_operations_owner_not_behind_began" CHECK (
    "began_epoch" IS NULL OR "owner_epoch" >= "began_epoch"
  ),

  -- Um efeito dado como realizado sempre aponta para a evidência externa —
  -- e string vazia não é evidência. (O IS NOT NULL explícito importa: um
  -- CHECK cujo resultado é NULL PASSA, e length(NULL) > 0 é NULL.)
  CONSTRAINT "effect_operations_success_has_reference" CHECK (
    "status" <> 'succeeded'
    OR ("provider_reference" IS NOT NULL AND length("provider_reference") > 0)
  ),

  -- Só um estado final pode ter vindo de uma pessoa.
  CONSTRAINT "effect_operations_resolution_is_final" CHECK (
    "resolved_by_user_id" IS NULL OR "status" IN ('succeeded', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS "effect_operations_execution_idx"
  ON "effect_operations" ("execution_id");

-- Para achar o que precisa de gente: operações ambíguas por workspace.
CREATE INDEX IF NOT EXISTS "effect_operations_unknown_idx"
  ON "effect_operations" ("workspace_id", "updated_at")
  WHERE "status" = 'unknown';

-- ---------------------------------------------------------------------
-- As transições válidas, garantidas pelo BANCO — não só pelo código que
-- escreve. Sem isto, um UPDATE qualquer (um script, um console, um bug
-- futuro) poderia devolver uma operação in_flight para reserved e a mesma
-- época mandaria de novo: reproduzido na revisão independente desta fase.
--
--   identidade (execução, nó, entidade, operação, chave, fingerprint,
--   política)            imutável
--   began_epoch          gravado uma vez, nunca muda depois
--   owner_epoch          só cresce
--   status               reserved  -> reserved | in_flight
--                        in_flight -> in_flight | unknown | succeeded | failed
--                        unknown   -> unknown | succeeded | failed
--                        succeeded/failed são finais — salvo quando o estado
--                        veio de uma PESSOA (resolved_by_user_id), que um fato
--                        do provedor pode substituir
--
-- Com isto, "no máximo uma vez" é propriedade do esquema: o ponto sem volta
-- (reserved -> in_flight) só pode ser cruzado uma vez por operação. O que o
-- banco NÃO impede: apagar a operação e reservá-la de novo — retenção só
-- pode purgar operações de execuções terminais (docs/async-execution.md).
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
        AND (OLD."resolved_by_user_id" IS NOT NULL
             OR (NEW."status" = OLD."status"
                 AND NEW."provider_reference" IS NOT DISTINCT FROM OLD."provider_reference"
                 AND NEW."last_error" IS NOT DISTINCT FROM OLD."last_error")))
  ) THEN
    RAISE EXCEPTION 'effect_operations: transition % -> % is not allowed', OLD."status", NEW."status";
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "effect_operations_guard" ON "effect_operations";
CREATE TRIGGER "effect_operations_guard"
  BEFORE UPDATE ON "effect_operations"
  FOR EACH ROW EXECUTE FUNCTION "effect_operations_guard_transitions"();

-- ---------------------------------------------------------------------
-- Histórico imutável: cada linha é UM fato sobre uma tentativa — reservou,
-- assumiu, cruzou o ponto sem volta, o provedor respondeu, alguém resolveu.
-- É aqui que um fato tardio aterrissa mesmo quando já não muda o estado
-- corrente: a confirmação de um worker superado nunca se perde.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "effect_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A ORDEM dos fatos. created_at não serve: dois eventos gravados na mesma
  -- transação (adopted + unknown) têm o mesmo now(). Por operação, a ordem
  -- de seq é a ordem real, porque todo escritor de eventos de uma operação
  -- segura o lock da linha dela enquanto grava.
  "seq" bigserial NOT NULL,
  "operation_id" uuid NOT NULL REFERENCES "effect_operations"("id") ON DELETE RESTRICT,

  "event" text NOT NULL
    CHECK ("event" IN ('reserved', 'adopted', 'began', 'succeeded', 'failed', 'unknown', 'resolved')),

  -- worker: uma época do worker. user: resolução manual por uma pessoa.
  -- system: o próprio banco, ao encerrar uma execução (ver o trigger abaixo).
  "actor" text NOT NULL CHECK ("actor" IN ('worker', 'user', 'system')),
  -- Época do worker que produziu o fato. Resolução manual e o sistema não
  -- têm época.
  "epoch" integer,
  "actor_user_id" uuid,

  "from_status" text,
  "to_status" text NOT NULL,
  -- Se o fato mudou o estado corrente. Falso quando chega tarde demais —
  -- e mesmo assim fica registrado.
  "applied" boolean NOT NULL,

  "provider_reference" text,
  -- Só dado não-secreto: código e mensagem de erro, nota de resolução.
  "detail" jsonb,

  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "effect_attempts_actor_shape" CHECK (
    ("actor" = 'worker' AND "epoch" IS NOT NULL AND "actor_user_id" IS NULL)
    OR ("actor" = 'user' AND "epoch" IS NULL AND "actor_user_id" IS NOT NULL)
    OR ("actor" = 'system' AND "epoch" IS NULL AND "actor_user_id" IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS "effect_attempts_operation_idx"
  ON "effect_attempts" ("operation_id", "seq");

-- Imutável de fato, não por convenção. DELETE continua possível porque é
-- assunto de retenção — e a regra de retenção está documentada em
-- docs/async-execution.md, não embutida aqui.
CREATE OR REPLACE FUNCTION "effect_attempts_reject_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'effect_attempts is append-only: history is never rewritten';
END $$;

DROP TRIGGER IF EXISTS "effect_attempts_no_update" ON "effect_attempts";
CREATE TRIGGER "effect_attempts_no_update"
  BEFORE UPDATE ON "effect_attempts"
  FOR EACH ROW EXECUTE FUNCTION "effect_attempts_reject_update"();

-- ---------------------------------------------------------------------
-- Uma execução terminal não tem operação "em voo".
--
-- in_flight quer dizer: "a época que cruzou o ponto sem volta ainda pode
-- contar o que aconteceu". Quando a posse passa para outra época, quem
-- assume converte a operação para unknown (adoptEffectOperation). Mas
-- quando a execução TERMINA — o worker finalizou mesmo sem conseguir gravar
-- o resultado da chamada, ou o reaper desistiu depois de esgotar as
-- tentativas — não existe próxima época para assumir. Sem isto a operação
-- ficaria in_flight para sempre: fora do índice do que precisa de gente, e
-- impossível de resolver (a resolução manual só parte de unknown).
--
-- O trigger faz a conversão no MESMO commit da transição terminal, qualquer
-- que seja o caminho que a fez e de qualquer estado não terminal —
-- finishQueuedExecution, abandonExecution, ou um cancelamento na fila que
-- ainda não existe. É uma invariante do banco, não uma disciplina de quem
-- chama.
--
-- O que ele NÃO faz:
--   - não mexe em operações "reserved": nada foi enviado, e é isso que o
--     estado já diz;
--   - não impede o fato tardio: se a época que fez a chamada ainda estiver
--     viva e receber a resposta do provedor, recordEffectOutcome aceita
--     unknown -> succeeded|failed por autoria (began_epoch).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "effect_operations_settle_on_terminal"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  WITH settled AS (
    UPDATE "effect_operations"
       SET "status" = 'unknown',
           "last_error" = jsonb_build_object(
             'code', 'EXTERNAL_EFFECT_UNKNOWN',
             'message', 'the execution ended while this operation was in flight'),
           "updated_at" = now()
     WHERE "execution_id" = NEW."id"
       AND "status" = 'in_flight'
    RETURNING "id", "began_epoch"
  )
  INSERT INTO "effect_attempts"
    ("operation_id", "event", "actor", "epoch", "actor_user_id",
     "from_status", "to_status", "applied", "detail")
  SELECT "id", 'unknown', 'system', NULL, NULL, 'in_flight', 'unknown', true,
         jsonb_build_object(
           'reason', 'the execution reached a terminal state while this operation was in flight',
           'executionStatus', NEW."status",
           'beganEpoch', "began_epoch")
    FROM settled;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "executions_settle_effects_on_terminal" ON "executions";
CREATE TRIGGER "executions_settle_effects_on_terminal"
  AFTER UPDATE OF "status" ON "executions"
  FOR EACH ROW
  -- De QUALQUER estado não terminal: uma operação fica in_flight também numa
  -- execução que voltou para a fila (reclaim), e cancelar uma execução na
  -- fila é um caminho previsto. Achado da revisão independente: com a
  -- condição antiga (só OLD = 'running'), queued -> cancelled deixava a
  -- operação in_flight para sempre.
  WHEN (OLD."status" NOT IN ('success', 'error', 'cancelled')
        AND NEW."status" IN ('success', 'error', 'cancelled'))
  EXECUTE FUNCTION "effect_operations_settle_on_terminal"();

-- RLS: habilitada, com leitura restrita a membros do workspace — mesmo
-- padrão das outras tabelas. Escrita pela conexão própria da aplicação.
ALTER TABLE "effect_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "effect_attempts" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "effect_operations_select_member" ON "effect_operations"
    FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM "workspace_members" wm
        WHERE wm."workspace_id" = "effect_operations"."workspace_id"
          AND wm."user_id" = auth.uid()
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "effect_attempts_select_member" ON "effect_attempts"
    FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM "effect_operations" eo
        JOIN "workspace_members" wm ON wm."workspace_id" = eo."workspace_id"
        WHERE eo."id" = "effect_attempts"."operation_id"
          AND wm."user_id" = auth.uid()
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
