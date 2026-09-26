-- Fase 4G: separar o lifecycle SÍNCRONO do circuito de recuperação assíncrona.
-- Nova migration — 0000/0001/0002/0003 não são modificadas.
-- Regenerate with `npm run db:generate` if you change lib/db/schema/executions.ts.
--
-- O PROBLEMA QUE ESTA COLUNA RESOLVE
-- Havia dois lifecycles distintos escrevendo na mesma tabela:
--
--   SYNC   request  -> running -> finishExecution          (createExecution)
--   ASYNC  queued   -> running -> finishQueuedExecution    (createQueuedExecution)
--
-- e o reaper procurava candidatos só por `status = 'running'`. Uma execução
-- síncrona legítima, ainda rodando dentro de uma request HTTP, era
-- indistinguível de um worker morto: reproduzido contra PostgreSQL real,
-- quatro varreduras a levavam de claim_attempts=0 até WORKER_CRASHED, sem
-- nenhum worker envolvido.
--
-- POR QUE UMA COLUNA, E NÃO `claim_attempts = 0`
-- Dava para inferir ("só o caminho assíncrono reclama, logo claim_attempts>0
-- implica worker"), e a inferência até é sólida hoje. Mas ela faz um contador
-- de tentativas responder a uma pergunta de propriedade, e passa a valer por
-- coincidência das transições atuais, não por regra. `runner` declara de quem
-- a execução é no momento em que ela nasce, e o banco passa a garantir isso.
--
--   'request' — roda dentro de uma request HTTP viva. NUNCA entra na fila,
--               NUNCA é reclamada, NUNCA é recuperada pelo reaper.
--   'worker'  — pertence à fila. É reclamada, pode ser devolvida para
--               'queued' pelo reaper, e pode ser abandonada.

ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "runner" text;

-- Backfill exato para linhas que já existem, sem chutar um valor único:
-- qualquer linha que já foi reclamada (claim_attempts > 0) ou que está na
-- fila só pode ter vindo do caminho assíncrono; o resto é síncrono.
UPDATE "executions"
SET "runner" = CASE
  WHEN "claim_attempts" > 0 OR "status" = 'queued' THEN 'worker'
  ELSE 'request'
END
WHERE "runner" IS NULL;

-- Default deliberadamente 'request': é o valor que mantém uma linha FORA do
-- circuito de recuperação. Se algum insert futuro esquecer de declarar, o
-- erro resultante é "esta execução nunca é recuperada" (inerte) e não "o
-- reaper pode matar esta execução" (destrutivo). Ambos os call sites do
-- repository declaram o valor explicitamente.
ALTER TABLE "executions" ALTER COLUMN "runner" SET DEFAULT 'request';
ALTER TABLE "executions" ALTER COLUMN "runner" SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE "executions"
    ADD CONSTRAINT "executions_runner_check" CHECK ("runner" IN ('request', 'worker'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A regra, garantida pelo banco e não só pelo código: uma execução síncrona
-- não pode existir na fila. Isso fecha o caminho inverso — nenhum bug de
-- aplicação consegue empurrar uma execução de request para 'queued' e daí
-- para dentro do circuito do worker.
DO $$ BEGIN
  ALTER TABLE "executions"
    ADD CONSTRAINT "executions_request_never_queued_check"
    CHECK ("runner" <> 'request' OR "status" <> 'queued');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Índice parcial para a varredura do reaper. Além de performance, ele
-- documenta no schema exatamente qual é o conjunto recuperável.
CREATE INDEX IF NOT EXISTS "executions_recovery_idx"
  ON "executions" ("started_at")
  WHERE "runner" = 'worker' AND "status" = 'running';

-- Sem mudança de RLS: a policy "executions_select_member" (0002) é
-- row-level, já cobre a coluna nova. Writes continuam pela conexão própria
-- da aplicação (não sujeita a RLS), autorizados em código — ver os dois
-- modelos em server/execution/execution-repository.ts.
