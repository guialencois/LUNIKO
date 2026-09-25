-- Fase 9: lease/heartbeat do worker.
-- Nova migration — 0000..0004 não são modificadas.
--
-- O PROBLEMA
-- Até aqui o único sinal de "esta execução travou" era
-- `started_at < now() - REAPER_STALE_MS`, ou seja: "faz muito tempo que
-- começou". Isso não distingue worker morto de worker vivo porém lento —
-- os dois parecem idênticos, porque nada que o worker faça durante a
-- execução chega ao banco. Enquanto os executores são puros e reversíveis
-- isso custa barato: no pior caso um trabalho interno é refeito. Deixa de
-- ser barato no instante em que um nó mandar mensagem, criar reserva ou
-- cobrar.
--
-- O QUE MUDA
-- `lease_expires_at` é uma afirmação com prazo: "o dono deste claim ainda
-- estava vivo, e se compromete a reafirmar isso antes deste instante". É
-- concedida atomicamente no claim e renovada pelo worker durante a
-- execução, sempre sob o MESMO fencing por época. O reaper passa a decidir
-- por ela, e não mais por `started_at`.
--
-- NULL CONTA COMO EXPIRADO, de propósito: proteção contra recuperação tem
-- de ser afirmativa. Uma linha "running" sem lease é uma linha que ninguém
-- declarou estar cuidando.

ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamptz;

-- Backfill determinístico para linhas que já existem: uma execução de
-- worker em andamento recebe o lease que teria recebido no claim, contado
-- a partir do seu próprio started_at. Linhas em fila ou já terminais
-- continuam sem lease — elas não têm dono.
UPDATE "executions"
SET "lease_expires_at" = "started_at" + interval '45 seconds'
WHERE "lease_expires_at" IS NULL
  AND "runner" = 'worker'
  AND "status" = 'running'
  AND "started_at" IS NOT NULL;

-- O índice de recuperação passa a apontar para a coluna que o reaper
-- realmente filtra. O anterior (por started_at) deixa de servir a essa
-- consulta.
DROP INDEX IF EXISTS "executions_recovery_idx";
CREATE INDEX IF NOT EXISTS "executions_recovery_idx"
  ON "executions" ("lease_expires_at")
  WHERE "runner" = 'worker' AND "status" = 'running';

-- Invariante que o banco passa a garantir: só uma execução de worker em
-- andamento pode ter lease. Fecha o caminho de um lease sobreviver a um
-- reclaim (que devolve para 'queued') ou a um finish — nenhum bug de
-- aplicação consegue deixar para trás um lease que proteja uma linha que
-- não está mais sendo executada.
DO $$ BEGIN
  ALTER TABLE "executions"
    ADD CONSTRAINT "executions_lease_only_while_running_check"
    CHECK (
      "lease_expires_at" IS NULL
      OR ("runner" = 'worker' AND "status" = 'running')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Sem mudança de RLS: a policy de 0002 é row-level e já cobre a coluna.
