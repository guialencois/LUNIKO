-- =====================================================================
-- Harness de lifecycle de execução — validação runtime em SQL.
--
-- POR QUE ISTO EXISTE
-- Os *.integration.test.ts deste projeto nunca rodaram: node_modules não
-- é instalável no ambiente de desenvolvimento (registry npm responde
-- 403), então vitest não executa. Este arquivo é o contorno. Cada função
-- h.* é transcrição literal da query Drizzle correspondente em
-- server/execution/execution-repository.ts, execution-queue.ts e
-- recovery-reaper.ts — mesmo SET, mesmos predicados de WHERE, mesma
-- ordem. Nada é "melhorado" aqui.
--
-- O QUE VALIDA / O QUE NÃO VALIDA
-- Valida as condições atômicas de transição de estado, contra um
-- PostgreSQL de verdade. NÃO valida o TypeScript: valida o SQL que o
-- TypeScript emite, transcrito à mão. Também não roda duas sessões em
-- paralelo — um arquivo psql é uma sessão só. Os casos de corrida aqui
-- exercitam o MESMO predicado atômico em sequência, que é onde a
-- garantia mora (um UPDATE condicional sob row lock); a concorrência
-- real de sessões é exercida à parte, em scripts/concurrency-check.sh.
--
-- SEÇÕES
--   1–5  lifecycle, tentativas, concorrência, síncrono fora da fila, documento
--   6    produtor da fila (4H)
--   7    lease / heartbeat (Fase 9)
--   8    efeitos externos (Fase 10) — com provedor FALSO; nada sai daqui
--   9    arquivar workflow; resolver "unknown" com evidência (Fase 10.5A)
--   10   RLS sem recursão, lida por um papel comum (migration 0008)
--
-- COMO LER O RESULTADO
-- Todo cenário deve dar PASS.
--
-- COMO RODAR
--   createdb apf4f
--   psql -d apf4f -c "CREATE SCHEMA auth;" \
--     -c "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
--         \$\$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid \$\$;"
--   for f in db/migrations/*.sql; do psql -d apf4f -f "$f"; done
--   psql -d apf4f -f scripts/f4f-lifecycle-harness.sql
--
-- (o stub de auth.uid() só é preciso fora do Supabase, onde a função já
--  existe — as migrations a usam nas policies de RLS.)
-- =====================================================================
\set QUIET on
SET client_min_messages = notice;
CREATE SCHEMA IF NOT EXISTS h;

-- ---------- fixtures -------------------------------------------------
CREATE OR REPLACE FUNCTION h.seed() RETURNS void LANGUAGE plpgsql AS $$
DECLARE ws uuid; usr uuid; wf uuid;
BEGIN
  -- Fase 10: effect_* referenciam executions/workspaces com ON DELETE
  -- RESTRICT (a prova de um efeito externo não some em cascata). Então o
  -- fixture apaga esse histórico explicitamente ANTES — que é exatamente a
  -- decisão deliberada que o RESTRICT exige de quem quiser apagar.
  DELETE FROM effect_attempts;
  DELETE FROM effect_operations;
  DELETE FROM workspaces;
  usr := gen_random_uuid();
  INSERT INTO workspaces (name) VALUES ('harness') RETURNING id INTO ws;
  INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (ws, usr, 'owner');
  INSERT INTO workflows (workspace_id, name, document, created_by)
    VALUES (ws, 'wf', '{"schemaVersion":1,"nodes":[],"edges":[],"settings":{}}'::jsonb, usr)
    RETURNING id INTO wf;
  -- tabela normal, não TEMP: scripts/concurrency-check.sh abre várias
  -- sessões psql e todas precisam enxergar o mesmo fixture.
  CREATE TABLE IF NOT EXISTS h.ctx (ws uuid, usr uuid, wf uuid);
  DELETE FROM h.ctx; INSERT INTO h.ctx VALUES (ws, usr, wf);
END $$;

CREATE OR REPLACE FUNCTION h.check(label text, got text, want text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF got IS NOT DISTINCT FROM want THEN
    RAISE NOTICE 'PASS  %  (%)', rpad(label, 56), got;
  ELSE
    RAISE WARNING 'FAIL  %  esperado: %  obtido: %', rpad(label, 56), want, got;
  END IF;
END $$;

-- ---------- transcrições: criação -------------------------------------

-- createQueuedExecution: runner 'worker', status 'queued', started_at null
CREATE OR REPLACE FUNCTION h.create_queued() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE eid uuid;
BEGIN
  INSERT INTO executions (workflow_id, workspace_id, status, document, trigger_type, runner, created_by)
  SELECT wf, ws, 'queued', '{"schemaVersion":1,"nodes":[],"edges":[],"settings":{}}'::jsonb,
         'manual', 'worker', usr FROM h.ctx RETURNING id INTO eid;
  RETURN eid;
END $$;

-- createExecution (caminho síncrono): runner 'request', já nasce 'running'
CREATE OR REPLACE FUNCTION h.create_sync() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE eid uuid;
BEGIN
  INSERT INTO executions (workflow_id, workspace_id, status, document, trigger_type, runner, started_at, created_by)
  SELECT wf, ws, 'running', '{}'::jsonb, 'manual', 'request', now(), usr FROM h.ctx RETURNING id INTO eid;
  RETURN eid;
END $$;

-- ---------- transcrições: claim ---------------------------------------

-- claimQueuedExecution — devolve a ÉPOCA concedida, ou NULL se não claimou.
-- Fase 9: o claim concede o lease no mesmo UPDATE.
CREATE OR REPLACE FUNCTION h.claim(eid uuid, lease_ms int DEFAULT 45000) RETURNS int LANGUAGE plpgsql AS $$
DECLARE ep int;
BEGIN
  UPDATE executions SET status='running', started_at=now(), claim_attempts=claim_attempts+1,
    lease_expires_at = now() + (lease_ms || ' milliseconds')::interval
  WHERE id=eid AND runner='worker' AND status='queued'
  RETURNING claim_attempts INTO ep;
  RETURN ep;
END $$;

-- claimNextQueuedExecution — SELECT ... FOR UPDATE SKIP LOCKED + UPDATE
CREATE OR REPLACE FUNCTION h.claim_next(lease_ms int DEFAULT 45000)
RETURNS TABLE(id uuid, epoch int) LANGUAGE plpgsql AS $$
DECLARE nid uuid;
BEGIN
  SELECT e.id INTO nid FROM executions e
  WHERE e.runner='worker' AND e.status='queued'
  ORDER BY e.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF nid IS NULL THEN RETURN; END IF;

  RETURN QUERY
  UPDATE executions SET status='running', started_at=now(), claim_attempts=claim_attempts+1,
    lease_expires_at = now() + (lease_ms || ' milliseconds')::interval
  WHERE executions.id=nid AND executions.runner='worker' AND executions.status='queued'
  RETURNING executions.id, executions.claim_attempts;
END $$;

-- renewExecutionLease (Fase 9) — heartbeat, com o MESMO fencing por época.
-- Não toca claim_attempts, não toca status.
CREATE OR REPLACE FUNCTION h.renew(eid uuid, epoch int, lease_ms int DEFAULT 45000) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r uuid;
BEGIN
  UPDATE executions SET lease_expires_at = now() + (lease_ms || ' milliseconds')::interval
  WHERE id=eid AND runner='worker' AND status='running' AND claim_attempts=epoch
  RETURNING id INTO r;
  RETURN r;
END $$;

-- helper de teste: faz o lease vencer sem esperar.
-- Só toca linha em "running": o banco recusa lease em qualquer outro
-- status (executions_lease_only_while_running_check), e uma execução
-- terminal já não é candidata a recuperação de qualquer forma.
CREATE OR REPLACE FUNCTION h.expire_lease(eid uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE executions SET lease_expires_at = now() - interval '1 second'
  WHERE id = eid AND runner = 'worker' AND status = 'running';
$$;

-- ---------- transcrições: recuperação ---------------------------------

-- reclaimExpiredExecution (4G+9): running com lease vencido -> queued,
-- SEM incrementar e SEM deixar lease para trás.
CREATE OR REPLACE FUNCTION h.reclaim(eid uuid, max_att int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r uuid;
BEGIN
  UPDATE executions SET status='queued', started_at=NULL, lease_expires_at=NULL
  WHERE id=eid AND runner='worker' AND status='running'
    AND (lease_expires_at IS NULL OR lease_expires_at < now())
    AND claim_attempts < max_att
  RETURNING id INTO r;
  RETURN r;
END $$;

-- abandonExecution: lease vencido + tentativas esgotadas -> WORKER_CRASHED
CREATE OR REPLACE FUNCTION h.abandon(eid uuid, max_att int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r uuid;
BEGIN
  UPDATE executions SET status='error', finished_at=now(), lease_expires_at=NULL,
    error='{"code":"WORKER_CRASHED","message":"lease expired"}'::jsonb
  WHERE id=eid AND runner='worker' AND status='running'
    AND (lease_expires_at IS NULL OR lease_expires_at < now())
    AND claim_attempts >= max_att
  RETURNING id INTO r;
  RETURN r;
END $$;

-- findStaleRunningExecutionIds
CREATE OR REPLACE FUNCTION h.find_stale() RETURNS SETOF uuid LANGUAGE sql AS $$
  SELECT id FROM executions
  WHERE runner='worker' AND status='running'
    AND (lease_expires_at IS NULL OR lease_expires_at < now());
$$;

-- recoverOne / recoverStaleExecutions
CREATE OR REPLACE FUNCTION h.recover_one(eid uuid, max_att int) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF h.reclaim(eid, max_att) IS NOT NULL THEN RETURN 'reclaimed'; END IF;
  IF h.abandon(eid, max_att) IS NOT NULL THEN RETURN 'abandoned'; END IF;
  RETURN 'skipped';
END $$;

CREATE OR REPLACE FUNCTION h.sweep(max_att int)
RETURNS TABLE(execution_id uuid, outcome text) LANGUAGE plpgsql AS $$
DECLARE i uuid;
BEGIN
  FOR i IN SELECT * FROM h.find_stale() LOOP
    execution_id := i; outcome := h.recover_one(i, max_att); RETURN NEXT;
  END LOOP;
END $$;

-- ---------- transcrições: escrita final -------------------------------

-- finishQueuedExecution — fencing por época + runner + status; limpa lease
CREATE OR REPLACE FUNCTION h.finish(eid uuid, st text, epoch int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r uuid;
BEGIN
  UPDATE executions SET status=st, finished_at=now(), duration_ms=10, lease_expires_at=NULL,
    result=CASE WHEN st='success' THEN '{"items":[{"json":{}}]}'::jsonb ELSE NULL END
  WHERE id=eid AND runner='worker' AND status='running' AND claim_attempts=epoch
  RETURNING id INTO r;
  RETURN r;
END $$;

-- finishExecution (síncrono) — runner 'request' + status running
CREATE OR REPLACE FUNCTION h.finish_sync(eid uuid, st text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r uuid;
BEGIN
  UPDATE executions SET status=st, finished_at=now(), duration_ms=10
  WHERE id=eid AND workspace_id=(SELECT ws FROM h.ctx)
    AND runner='request' AND status='running'
  RETURNING id INTO r;
  RETURN r;
END $$;

-- insertExecutionNodesInternal — fenced, e SUBSTITUI a tentativa anterior
CREATE OR REPLACE FUNCTION h.insert_nodes(eid uuid, epoch int, label text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  PERFORM 1 FROM executions
  WHERE id=eid AND runner='worker' AND status='running' AND claim_attempts=epoch
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  DELETE FROM execution_nodes WHERE execution_id=eid;
  INSERT INTO execution_nodes (execution_id, node_id, node_type, status, duration_ms, started_at, finished_at)
  VALUES (eid, label, 'set', 'success', 1, now(), now());
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- =====================================================================
SELECT h.seed();
DO $$
DECLARE e uuid; o text; st text; att int; n int; ep int; epA int; epB int;
        r uuid; i int; nid uuid; runner_val text;
  MAX_ATT  constant int := 3;
BEGIN

RAISE NOTICE '';
RAISE NOTICE '== 1. Ciclo completo de recuperação (A-H do prompt) ==';

-- A. worker A faz claim
e := h.create_queued();
SELECT claim_attempts INTO att FROM executions WHERE id=e;
PERFORM h.check('A0 nasce na fila, zero tentativas',
  (SELECT status||'/'||claim_attempts FROM executions WHERE id=e), 'queued/0');
epA := h.claim(e);
SELECT status INTO st FROM executions WHERE id=e;
PERFORM h.check('A  worker A faz claim (época 1)', st||'/'||epA, 'running/1');

-- B. worker A executa e grava seus nós
n := h.insert_nodes(e, epA, 'no-do-worker-A');
PERFORM h.check('B  worker A grava execution_nodes', n::text, '1');

-- C. A fica stale
PERFORM h.expire_lease(e);

-- D. reaper recupera -> volta para a FILA
o := h.recover_one(e, MAX_ATT);
SELECT status, claim_attempts INTO st, att FROM executions WHERE id=e;
PERFORM h.check('D  reaper devolve para a fila', o||'/'||st||'/'||att, 'reclaimed/queued/1');
PERFORM h.check('D2 started_at volta a NULL (queued não começou)',
  (SELECT (started_at IS NULL)::text FROM executions WHERE id=e), 'true');
PERFORM h.check('D3 reclaim NÃO consumiu tentativa', att::text, '1');

-- E. worker B faz claim — via claimNextQueuedExecution, a fila de verdade
SELECT c.id, c.epoch INTO nid, epB FROM h.claim_next() c;
PERFORM h.check('E  worker B pega da fila (época 2)',
  (nid = e)::text||'/'||epB, 'true/2');

-- F/G. worker A acorda e tenta finalizar com a época antiga
r := h.finish(e, 'success', epA);
SELECT status INTO st FROM executions WHERE id=e;
PERFORM h.check('G  worker A é rejeitado pelo fencing', (r IS NULL)::text||'/'||st, 'true/running');

-- worker A também não consegue mexer em execution_nodes
n := h.insert_nodes(e, epA, 'no-tardio-do-A');
PERFORM h.check('G2 worker A não altera execution_nodes', coalesce(n::text,'NULL'), 'NULL');

-- H. worker B finaliza
n := h.insert_nodes(e, epB, 'no-do-worker-B');
r := h.finish(e, 'success', epB);
SELECT status INTO st FROM executions WHERE id=e;
PERFORM h.check('H  worker B finaliza normalmente', (r IS NOT NULL)::text||'/'||st, 'true/success');

-- e o histórico mostra UMA tentativa, não duas
SELECT count(*) INTO n FROM execution_nodes WHERE execution_id=e;
SELECT node_id INTO o FROM execution_nodes WHERE execution_id=e;
PERFORM h.check('H2 execution_nodes tem só a tentativa vencedora', n::text||'/'||o, '1/no-do-worker-B');

RAISE NOTICE '';
RAISE NOTICE '== 2. Tentativas e abandono definitivo ==';

e := h.create_queued();
FOR i IN 1..MAX_ATT LOOP
  ep := h.claim(e);
  PERFORM h.expire_lease(e);
  o := h.recover_one(e, MAX_ATT);
  IF i < MAX_ATT THEN
    PERFORM h.check('  claim '||i||' -> stale -> reclaim', o||'/época='||ep,
                    'reclaimed/época='||i);
  ELSE
    PERFORM h.check('  claim '||i||' -> stale -> abandono', o||'/época='||ep,
                    'abandoned/época='||i);
  END IF;
END LOOP;
SELECT status, error->>'code', claim_attempts INTO st, o, att FROM executions WHERE id=e;
PERFORM h.check('  estado final após esgotar tentativas', st||'/'||o||'/'||att,
                'error/WORKER_CRASHED/3');

RAISE NOTICE '';
RAISE NOTICE '== 3. Concorrência ==';

-- dois reapers sobre a mesma linha
e := h.create_queued(); ep := h.claim(e); PERFORM h.expire_lease(e);
o := h.recover_one(e, MAX_ATT);
st := h.recover_one(e, MAX_ATT);
SELECT claim_attempts INTO att FROM executions WHERE id=e;
PERFORM h.check('  dois reapers: um recupera, outro pula', o||'/'||st||'/'||att,
                'reclaimed/skipped/1');

-- dois workers tentando o mesmo id
epA := h.claim(e); epB := h.claim(e);
PERFORM h.check('  dois workers no mesmo id: só um claima',
  coalesce(epA::text,'NULL')||'/'||coalesce(epB::text,'NULL'), '2/NULL');

-- reclaim concorrente com finish: quem terminou primeiro ganha
e := h.create_queued(); ep := h.claim(e); PERFORM h.expire_lease(e);
r := h.finish(e, 'success', ep);
o := h.recover_one(e, MAX_ATT);
SELECT status INTO st FROM executions WHERE id=e;
PERFORM h.check('  finish antes do reclaim: estado final preservado',
  (r IS NOT NULL)::text||'/'||o||'/'||st, 'true/skipped/success');

-- reclaim antes do finish: o finish antigo é rejeitado
e := h.create_queued(); ep := h.claim(e); PERFORM h.expire_lease(e);
o := h.recover_one(e, MAX_ATT);
r := h.finish(e, 'success', ep);
SELECT status INTO st FROM executions WHERE id=e;
PERFORM h.check('  reclaim antes do finish: finish rejeitado',
  o||'/'||(r IS NULL)::text||'/'||st, 'reclaimed/true/queued');

-- abandon concorrente com finish
e := h.create_queued(); ep := h.claim(e);
UPDATE executions SET claim_attempts=MAX_ATT WHERE id=e;
PERFORM h.expire_lease(e);
o := h.recover_one(e, MAX_ATT);
r := h.finish(e, 'success', ep);
SELECT status, error->>'code' INTO st, o FROM executions WHERE id=e;
PERFORM h.check('  abandon antes do finish: WORKER_CRASHED mantido',
  (r IS NULL)::text||'/'||st||'/'||o, 'true/error/WORKER_CRASHED');

-- execução não-stale não é recuperada
e := h.create_queued(); ep := h.claim(e);
SELECT count(*) INTO n FROM h.sweep(MAX_ATT) s WHERE s.execution_id=e;
PERFORM h.check('  execução não-stale não é candidata',
  n::text||'/'||(SELECT status FROM executions WHERE id=e), '0/running');

-- execução já terminal não é recuperada
e := h.create_queued(); ep := h.claim(e); PERFORM h.finish(e,'success',ep);
PERFORM h.expire_lease(e);
SELECT count(*) INTO n FROM h.sweep(MAX_ATT) s WHERE s.execution_id=e;
PERFORM h.check('  execução terminal não é candidata',
  n::text||'/'||(SELECT status FROM executions WHERE id=e), '0/success');

RAISE NOTICE '';
RAISE NOTICE '== 4. Execução síncrona fora do circuito de recuperação ==';

e := h.create_sync();
SELECT runner, status, claim_attempts INTO runner_val, st, att FROM executions WHERE id=e;
PERFORM h.check('  nasce runner=request', runner_val||'/'||st||'/'||att, 'request/running/0');

-- quatro varreduras: antes da 4G isto a levava a WORKER_CRASHED
FOR i IN 1..4 LOOP
  PERFORM h.expire_lease(e);
  PERFORM h.sweep(MAX_ATT);
END LOOP;
SELECT status, claim_attempts INTO st, att FROM executions WHERE id=e;
PERFORM h.check('  4 varreduras do reaper não a tocam', st||'/'||att, 'running/0');

-- e ela termina normalmente pelo caminho síncrono
r := h.finish_sync(e, 'success');
PERFORM h.check('  finish síncrono funciona',
  (r IS NOT NULL)::text||'/'||(SELECT status FROM executions WHERE id=e), 'true/success');

-- o banco impede que uma execução de request chegue à fila
BEGIN
  e := h.create_sync();
  UPDATE executions SET status='queued' WHERE id=e;
  PERFORM h.check('  banco recusa request na fila', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('  banco recusa request na fila', 'CHECK violation', 'CHECK violation');
END;

-- finish síncrono não sobrescreve estado recuperado por worker
e := h.create_queued(); ep := h.claim(e);
UPDATE executions SET claim_attempts=MAX_ATT WHERE id=e;
PERFORM h.expire_lease(e);
PERFORM h.recover_one(e, MAX_ATT);
r := h.finish_sync(e, 'success');
SELECT status, error->>'code' INTO st, o FROM executions WHERE id=e;
PERFORM h.check('  finish síncrono não sobrescreve WORKER_CRASHED',
  (r IS NULL)::text||'/'||st||'/'||o, 'true/error/WORKER_CRASHED');

-- e o finish assíncrono não alcança uma execução síncrona (época 0)
e := h.create_sync();
r := h.finish(e, 'success', 0);
PERFORM h.check('  finish assíncrono não alcança execução síncrona',
  (r IS NULL)::text||'/'||(SELECT status FROM executions WHERE id=e), 'true/running');

RAISE NOTICE '';
RAISE NOTICE '== 5. Integridade do documento executado (correção do redact) ==';

DECLARE authored jsonb; stored jsonb; wf_doc jsonb;
BEGIN
authored := '{
  "schemaVersion": 1,
  "nodes": [
    {"id":"s","type":"set","name":"Dados da reserva","position":{"x":200,"y":0},
     "data":{"values":{"bookingKey":"LEN-2026-0417","tokenVoucher":"V-88213"}}},
    {"id":"h","type":"httpRequest","name":"Confirmar","position":{"x":400,"y":0},
     "data":{"headers":{"Authorization":"Bearer sk-live-9f3a2b"}}}
  ],
  "edges": [], "settings": {"executionMode":"default"}
}'::jsonb;

INSERT INTO executions (workflow_id, workspace_id, status, document, trigger_type, runner, created_by)
SELECT wf, ws, 'queued', authored, 'manual', 'worker', usr FROM h.ctx RETURNING id INTO e;
SELECT document INTO stored FROM executions WHERE id=e;

PERFORM h.check('  documento guardado == documento autorado', (stored = authored)::text, 'true');
PERFORM h.check('  Set.bookingKey sobrevive',
  stored->'nodes'->0->'data'->'values'->>'bookingKey', 'LEN-2026-0417');
PERFORM h.check('  Set.tokenVoucher sobrevive',
  stored->'nodes'->0->'data'->'values'->>'tokenVoucher', 'V-88213');
PERFORM h.check('  header real chega íntegro ao worker',
  stored->'nodes'->1->'data'->'headers'->>'Authorization', 'Bearer sk-live-9f3a2b');
PERFORM h.check('  nenhum [REDACTED] no documento executado',
  (stored::text LIKE '%[REDACTED]%')::text, 'false');

UPDATE workflows SET document = authored WHERE id = (SELECT wf FROM h.ctx);
SELECT document INTO wf_doc FROM workflows WHERE id = (SELECT wf FROM h.ctx);
PERFORM h.check('  sync e async partem do mesmo documento', (wf_doc = stored)::text, 'true');
END;

RAISE NOTICE '';
END $$;

-- =====================================================================
-- Seção 6 — o produtor da fila (Fase 4H)
--
-- Até a 4H, createQueuedExecution não tinha call site de produção: toda a
-- fila existia e era válida, mas nada da aplicação colocava trabalho
-- nela. Esta seção verifica o contrato que o produtor grava e que o
-- worker consegue DESCOBRIR o job sozinho (claimNextQueuedExecution), sem
-- ninguém lhe entregar um id.
-- =====================================================================
SELECT h.seed();
DO $$
DECLARE e uuid; sync_e uuid; nid uuid; ep int; st text; r uuid; n int;
  MAX_ATT  constant int := 3;
BEGIN
RAISE NOTICE '';
RAISE NOTICE '== 6. Produtor da fila (4H) ==';

-- linha exatamente como enqueueWorkflowExecution a deixa
e := h.create_queued();
PERFORM h.check('  produtor grava queued/worker/0/started_at NULL',
  (SELECT status||'/'||runner||'/'||claim_attempts||'/'||(started_at IS NULL)::text
   FROM executions WHERE id=e), 'queued/worker/0/true');

-- nada foi executado durante a request
SELECT count(*) INTO n FROM execution_nodes WHERE execution_id=e;
PERFORM h.check('  nada executado durante a request',
  n::text||'/'||(SELECT coalesce(result::text,'null')||'/'||coalesce(finished_at::text,'null')
                 FROM executions WHERE id=e), '0/null/null');

-- uma execução síncrona NÃO é descoberta pelo worker
sync_e := h.create_sync();
SELECT c.id, c.epoch INTO nid, ep FROM h.claim_next() c;
PERFORM h.check('  worker descobre o job da fila (não o síncrono)',
  (nid = e)::text||'/'||ep, 'true/1');
PERFORM h.check('  execução síncrona segue intocada',
  (SELECT status||'/'||claim_attempts FROM executions WHERE id=sync_e), 'running/0');

-- e o ciclo fecha pelo fencing normal
n := h.insert_nodes(e, ep, 'no-do-worker');
r := h.finish(e, 'success', ep);
PERFORM h.check('  worker finaliza o job do produtor',
  (r IS NOT NULL)::text||'/'||(SELECT status FROM executions WHERE id=e), 'true/success');

-- fila vazia: claim_next não devolve nada (nem a síncrona)
SELECT count(*) INTO n FROM h.claim_next();
PERFORM h.check('  fila vazia não devolve a execução síncrona', n::text, '0');

RAISE NOTICE '';
END $$;

-- =====================================================================
-- Seção 7 — lease / heartbeat (Fase 9)
--
-- O que muda em relação às seções anteriores: "recuperável" deixou de ser
-- "started_at velho" e passou a ser "lease vencido". O heartbeat é a única
-- coisa que adia isso, e ele usa exatamente o mesmo fencing por época das
-- escritas finais — não é um caminho paralelo.
-- =====================================================================
SELECT h.seed();
DO $$
DECLARE e uuid; o text; st text; att int; n int; ep int; epA int; epB int; r uuid;
  MAX_ATT constant int := 3;
BEGIN
RAISE NOTICE '';
RAISE NOTICE '== 7. Lease / heartbeat ==';

-- A. o dono atual renova
e := h.create_queued(); ep := h.claim(e, 45000);
PERFORM h.expire_lease(e);
r := h.renew(e, ep);
PERFORM h.check('A  dono atual renova o lease',
  (r IS NOT NULL)::text||'/'||(SELECT (lease_expires_at > now())::text FROM executions WHERE id=e), 'true/true');

-- D. renovar não mexe em claim_attempts nem em status
SELECT claim_attempts, status INTO att, st FROM executions WHERE id=e;
PERFORM h.renew(e, ep); PERFORM h.renew(e, ep);
PERFORM h.check('D  renovar não altera claim_attempts nem status',
  (SELECT claim_attempts||'/'||status FROM executions WHERE id=e), att||'/'||st);

-- E. lease válido não é recuperado, por mais que o reaper varra
FOR n IN 1..3 LOOP PERFORM h.sweep(MAX_ATT); END LOOP;
PERFORM h.check('E  lease válido: reaper não recupera',
  (SELECT status||'/'||claim_attempts FROM executions WHERE id=e), 'running/'||att);

-- F. lease vencido é recuperável
PERFORM h.expire_lease(e);
o := h.recover_one(e, MAX_ATT);
PERFORM h.check('F  lease vencido: recuperável',
  o||'/'||(SELECT status FROM executions WHERE id=e), 'reclaimed/queued');
PERFORM h.check('F2 volta à fila sem lease',
  (SELECT (lease_expires_at IS NULL)::text FROM executions WHERE id=e), 'true');

-- B. worker antigo não renova depois do reclaim
e := h.create_queued(); epA := h.claim(e);
PERFORM h.expire_lease(e);
PERFORM h.recover_one(e, MAX_ATT);          -- volta para a fila
epB := h.claim(e);                           -- worker B assume, época nova
r := h.renew(e, epA);
PERFORM h.check('B  worker antigo não renova após reclaim',
  (r IS NULL)::text||'/época A='||epA||'/época B='||epB, 'true/época A=1/época B=2');

-- B2. e nem depois de dois reclaims
PERFORM h.expire_lease(e);
PERFORM h.recover_one(e, MAX_ATT);
ep := h.claim(e);
PERFORM h.check('B2 nem após dois reclaims',
  (h.renew(e, epA) IS NULL)::text||'/'||(h.renew(e, epB) IS NULL)::text||'/'||(h.renew(e, ep) IS NOT NULL)::text,
  'true/true/true');

-- G. o worker antigo não RESSUSCITA a execução depois de B assumir.
--    Este é o caso que o lease sozinho não resolveria: sem o fencing por
--    época, o heartbeat de A estenderia o lease que agora é de B.
--    Execução nova, para o contador de tentativas não vir contaminado.
e := h.create_queued(); epA := h.claim(e);
PERFORM h.expire_lease(e);
PERFORM h.recover_one(e, MAX_ATT);
epB := h.claim(e);                           -- B é o dono (época 2)
PERFORM h.expire_lease(e);                   -- B travou
r := h.renew(e, epA);                        -- A acorda e tenta renovar
PERFORM h.check('G  heartbeat do antigo não estende o lease do novo dono',
  (r IS NULL)::text||'/'||(SELECT (lease_expires_at < now())::text FROM executions WHERE id=e), 'true/true');
-- (dois comandos: uma subquery no MESMO comando do recover_one leria o
--  snapshot de antes dele, e a contagem de tentativas não provaria nada)
o := h.recover_one(e, MAX_ATT);
PERFORM h.check('G2 e a execução segue recuperável pelo reaper',
  o||'/tentativas='||(SELECT claim_attempts FROM executions WHERE id=e),
  'reclaimed/tentativas=2');

-- C. heartbeat depois do finish é rejeitado
e := h.create_queued(); ep := h.claim(e);
PERFORM h.finish(e, 'success', ep);
r := h.renew(e, ep);
PERFORM h.check('C  heartbeat após finish é rejeitado',
  (r IS NULL)::text||'/'||(SELECT status FROM executions WHERE id=e), 'true/success');
PERFORM h.check('C2 finish deixou a linha sem lease',
  (SELECT (lease_expires_at IS NULL)::text FROM executions WHERE id=e), 'true');

-- H. corrida finish vs heartbeat
e := h.create_queued(); ep := h.claim(e);
r := h.finish(e, 'success', ep);
PERFORM h.check('H  finish primeiro: heartbeat seguinte é recusado',
  (r IS NOT NULL)::text||'/'||(h.renew(e, ep) IS NULL)::text, 'true/true');

e := h.create_queued(); ep := h.claim(e);
PERFORM h.renew(e, ep);
r := h.finish(e, 'success', ep);
PERFORM h.check('H2 heartbeat primeiro: finish do dono ainda passa',
  (r IS NOT NULL)::text||'/'||(SELECT status FROM executions WHERE id=e), 'true/success');

-- I. corrida reclaim vs heartbeat
e := h.create_queued(); ep := h.claim(e);
PERFORM h.renew(e, ep);                      -- renovou: não é candidato
PERFORM h.check('I  reclaim depois de renovar: não acha candidato',
  h.recover_one(e, MAX_ATT)||'/'||(SELECT status FROM executions WHERE id=e), 'skipped/running');

PERFORM h.expire_lease(e);
o := h.recover_one(e, MAX_ATT);              -- agora recupera
PERFORM h.check('I2 reclaim depois de vencer: recupera, e o heartbeat tardio falha',
  o||'/'||(h.renew(e, ep) IS NULL)::text||'/'||(SELECT status FROM executions WHERE id=e),
  'reclaimed/true/queued');

-- lease nunca sobrevive fora de "running" — garantido pelo banco
e := h.create_queued();
BEGIN
  UPDATE executions SET lease_expires_at = now() + interval '1 minute' WHERE id = e;
  PERFORM h.check('   banco recusa lease em linha na fila', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('   banco recusa lease em linha na fila', 'CHECK violation', 'CHECK violation');
END;

RAISE NOTICE '';
END $$;

-- =====================================================================
-- Seção 8 — efeitos externos (Fase 10)
--
-- Transcrição de server/execution/effects/effect-repository.ts — mesmo
-- predicado de WHERE, mesmos locks (FOR SHARE na execução para DECISÕES,
-- FOR UPDATE na operação), mesma ordem. Cada função h.eff_* é UMA
-- transação no TypeScript.
--
-- O provedor é FALSO: h.fake_provider_ledger registra cada requisição que
-- ele "aceitou" — o substituto de "o que existe no mundo lá fora". Ele não
-- deduplica nada (pior caso, como um provedor sem chave idempotente), então
-- uma duplicata apareceria aqui. Nenhuma mensagem real é enviada.
--
-- O runner de verdade (effect-runner.ts) roda em Node contra estas mesmas
-- condições; aqui elas rodam contra o PostgreSQL. A corrida real entre
-- duas sessões (teste C) está em scripts/concurrency-check.sh, cenário 6.
-- =====================================================================

-- a chave: sha256 do JSON canônico de ["v1", executionId, nodeId,
-- businessKey, operation] — o mesmo texto que effect-key.ts produz.
CREATE OR REPLACE FUNCTION h.eff_key(eid uuid, node text, bkey text, op text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(
    '["v1",' || to_json(eid::text)::text || ',' || to_json(node)::text || ','
             || to_json(bkey)::text || ',' || to_json(op)::text || ']', 'UTF8')), 'hex');
$$;

CREATE TABLE IF NOT EXISTS h.fake_provider_ledger (
  seq serial PRIMARY KEY, idempotency_key text NOT NULL, reference text NOT NULL);

CREATE OR REPLACE FUNCTION h.provider_accept(k text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  INSERT INTO h.fake_provider_ledger (idempotency_key, reference)
  VALUES (k, 'fake-msg-' || (SELECT count(*) + 1 FROM h.fake_provider_ledger))
  RETURNING reference INTO r;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION h.accepted(k text) RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM h.fake_provider_ledger WHERE idempotency_key = k;
$$;

-- executionOwnedBy — o fence das DECISÕES
CREATE OR REPLACE FUNCTION h.eff_owned(eid uuid, epoch int) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM executions
   WHERE id = eid AND runner = 'worker' AND status = 'running' AND claim_attempts = epoch
   FOR SHARE;
  RETURN FOUND;
END $$;

-- reserveEffectOperation
CREATE OR REPLACE FUNCTION h.eff_reserve(eid uuid, node text, bkey text, op text, fp text, epoch int)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE k text := h.eff_key(eid, node, bkey, op); ins uuid;
BEGIN
  IF NOT h.eff_owned(eid, epoch) THEN RETURN 'fenced'; END IF;
  INSERT INTO effect_operations (execution_id, workspace_id, node_id, business_key, operation,
      idempotency_key, delivery_policy, payload_fingerprint, status, owner_epoch)
  SELECT eid, workspace_id, node, bkey, op, k, 'at_most_once', fp, 'reserved', epoch
    FROM executions WHERE id = eid
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO ins;
  IF ins IS NULL THEN RETURN 'exists'; END IF;
  INSERT INTO effect_attempts (operation_id, event, actor, epoch, from_status, to_status, applied)
  VALUES (ins, 'reserved', 'worker', epoch, NULL, 'reserved', true);
  RETURN 'reserved';
END $$;

-- adoptEffectOperation
CREATE OR REPLACE FUNCTION h.eff_adopt(opid uuid, eid uuid, epoch int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE o effect_operations%ROWTYPE; nxt text;
BEGIN
  IF NOT h.eff_owned(eid, epoch) THEN RETURN 'fenced'; END IF;
  SELECT * INTO o FROM effect_operations WHERE id = opid FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  IF o.execution_id <> eid THEN RETURN 'fenced'; END IF;
  IF o.owner_epoch >= epoch THEN RETURN 'stale'; END IF;
  IF o.status NOT IN ('reserved', 'in_flight') THEN RETURN 'stale'; END IF;
  nxt := CASE WHEN o.status = 'in_flight' THEN 'unknown' ELSE 'reserved' END;
  UPDATE effect_operations SET owner_epoch = epoch, status = nxt, updated_at = now()
   WHERE id = o.id AND execution_id = eid AND owner_epoch < epoch AND status = o.status;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  INSERT INTO effect_attempts (operation_id, event, actor, epoch, from_status, to_status, applied, detail)
  VALUES (o.id, 'adopted', 'worker', epoch, o.status, nxt, true,
          jsonb_build_object('previousOwnerEpoch', o.owner_epoch));
  IF nxt = 'unknown' THEN
    INSERT INTO effect_attempts (operation_id, event, actor, epoch, from_status, to_status, applied, detail)
    VALUES (o.id, 'unknown', 'worker', epoch, 'in_flight', 'unknown', true,
            jsonb_build_object('reason', 'a previous attempt crossed the point of no return and never reported an outcome',
                               'beganEpoch', o.began_epoch));
  END IF;
  RETURN 'done';
END $$;

-- beginEffectOperation — o ponto sem volta, uma vez por operação
CREATE OR REPLACE FUNCTION h.eff_begin(opid uuid, eid uuid, epoch int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE o effect_operations%ROWTYPE;
BEGIN
  IF NOT h.eff_owned(eid, epoch) THEN RETURN 'fenced'; END IF;
  SELECT * INTO o FROM effect_operations WHERE id = opid FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  IF o.execution_id <> eid THEN RETURN 'fenced'; END IF;
  IF o.owner_epoch <> epoch OR o.status <> 'reserved' OR o.began_epoch IS NOT NULL THEN RETURN 'stale'; END IF;
  UPDATE effect_operations SET status = 'in_flight', began_epoch = epoch, updated_at = now()
   WHERE id = o.id AND execution_id = eid AND owner_epoch = epoch
     AND status = 'reserved' AND began_epoch IS NULL;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  INSERT INTO effect_attempts (operation_id, event, actor, epoch, from_status, to_status, applied)
  VALUES (o.id, 'began', 'worker', epoch, 'reserved', 'in_flight', true);
  RETURN 'done';
END $$;

-- recordEffectOutcome — FATO, cercado só por autoria (mesma execução e
-- began_epoch). Substitui uma resolução HUMANA; nunca outro fato.
CREATE OR REPLACE FUNCTION h.eff_record(opid uuid, eid uuid, epoch int, kind text,
    ref text DEFAULT NULL, code text DEFAULT NULL, msg text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE o effect_operations%ROWTYPE; target text; authored boolean; applies boolean; cur text;
        overrides boolean; from_pending boolean;
BEGIN
  SELECT * INTO o FROM effect_operations WHERE id = opid FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  target := CASE kind WHEN 'succeeded' THEN 'succeeded' WHEN 'failed' THEN 'failed' ELSE 'unknown' END;
  overrides := target <> 'unknown' AND o.status IN ('succeeded', 'failed') AND o.resolved_by_user_id IS NOT NULL;
  from_pending := CASE WHEN target = 'unknown' THEN o.status = 'in_flight'
                       ELSE o.status IN ('in_flight', 'unknown') END;
  authored := o.execution_id = eid AND coalesce(o.began_epoch = epoch, false);
  applies := authored AND (from_pending OR overrides);
  cur := o.status;
  IF applies THEN
    UPDATE effect_operations SET
      status = target,
      provider_reference = CASE WHEN kind = 'succeeded' THEN ref ELSE NULL END,
      last_error = CASE WHEN kind = 'failed' THEN jsonb_build_object('code', code, 'message', msg)
                        WHEN kind = 'unknown' THEN jsonb_build_object('code', 'EXTERNAL_EFFECT_UNKNOWN', 'message', msg)
                        ELSE NULL END,
      resolved_by_user_id = NULL,
      resolution = NULL,
      updated_at = now()
    WHERE id = o.id AND execution_id = eid AND began_epoch = epoch
      AND (CASE WHEN target = 'unknown' THEN status = 'in_flight'
                ELSE status IN ('in_flight', 'unknown')
                     OR (status IN ('succeeded', 'failed') AND resolved_by_user_id IS NOT NULL) END);
    IF NOT FOUND THEN RAISE EXCEPTION 'effect operation vanished while locked'; END IF;
    cur := target;
  END IF;
  INSERT INTO effect_attempts (operation_id, event, actor, epoch, from_status, to_status, applied,
                               provider_reference, detail)
  VALUES (o.id, target, 'worker', epoch, o.status, cur, applies,
          CASE WHEN kind = 'succeeded' THEN ref END,
          CASE WHEN kind = 'failed' THEN jsonb_build_object('code', code, 'message', msg)
               WHEN kind = 'unknown' THEN jsonb_build_object('reason', msg) ELSE '{}'::jsonb END
          || CASE WHEN NOT authored THEN jsonb_build_object('notApplied', 'reported by an epoch that did not make the call')
                  WHEN NOT applies THEN jsonb_build_object('notApplied', 'operation was already ' || o.status)
                  WHEN overrides THEN jsonb_build_object('overridesResolution',
                         jsonb_build_object('status', o.status, 'resolution', o.resolution,
                                            'resolvedByUserId', o.resolved_by_user_id))
                  ELSE '{}'::jsonb END);
  RETURN applies;
END $$;

-- resolveUnknownEffectOperation (MODELO 1, Fase 10.5A). A validação do
-- corpo do pedido (resolution.ts, zod) acontece antes, em Node — aqui está
-- o que o REPOSITÓRIO faz, na mesma ordem, e o banco segura o resto (os
-- CHECKs da 0007 valem para qualquer caminho, inclusive este).
-- Devolve o `outcome` do TypeScript: resolved | forbidden | not_found |
-- not_unknown:<status> | execution_active:<status> | too_early.
-- Não-membro: exceção FORBIDDEN, como requireWorkspaceMembership.
CREATE OR REPLACE FUNCTION h.eff_resolve(opid uuid, res text, ref text, ev_source text, ev_detail text,
    justification text, cooling int DEFAULT 0, who uuid DEFAULT NULL, ws_in uuid DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE o effect_operations%ROWTYPE; u uuid := coalesce(who, (SELECT usr FROM h.ctx));
        wsid uuid := coalesce(ws_in, (SELECT ws FROM h.ctx)); member_role text; ex_status text;
        ready boolean; st text;
BEGIN
  -- requireWorkspaceMembership + RESOLVER_ROLES
  SELECT role INTO member_role FROM workspace_members WHERE workspace_id = wsid AND user_id = u LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'FORBIDDEN: user is not a member of this workspace'; END IF;
  IF member_role NOT IN ('owner', 'admin') THEN RETURN 'forbidden'; END IF;
  -- uma transação, operação travada
  SELECT * INTO o FROM effect_operations WHERE id = opid AND workspace_id = wsid LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF o.status <> 'unknown' THEN RETURN 'not_unknown:' || o.status; END IF;
  SELECT status INTO ex_status FROM executions WHERE id = o.execution_id LIMIT 1;
  IF ex_status IS NULL OR ex_status NOT IN ('success', 'error', 'cancelled') THEN
    RETURN 'execution_active:' || coalesce(ex_status, 'missing');
  END IF;
  -- resfriamento, no relógio do banco, a partir do primeiro 'began'
  SELECT coalesce(min(created_at), o.created_at) + cooling * interval '1 second' <= now() INTO ready
    FROM effect_attempts WHERE operation_id = o.id AND event = 'began';
  IF NOT ready THEN RETURN 'too_early'; END IF;
  st := CASE WHEN res = 'confirmed_sent' THEN 'succeeded' ELSE 'failed' END;
  UPDATE effect_operations SET
    status = st,
    provider_reference = CASE WHEN res = 'confirmed_sent' THEN ref ELSE NULL END,
    last_error = CASE WHEN st = 'failed'
                      THEN jsonb_build_object('code', CASE WHEN res = 'confirmed_not_sent' THEN 'RESOLVED_NOT_SENT'
                                                           ELSE 'RESOLVED_REJECTED' END,
                                              'message', justification)
                      ELSE NULL END,
    resolved_by_user_id = u,
    resolution = res,
    updated_at = now()
  WHERE id = o.id AND status = 'unknown';
  IF NOT FOUND THEN RETURN 'not_unknown:' || o.status; END IF;
  INSERT INTO effect_attempts (operation_id, event, actor, epoch, actor_user_id, from_status, to_status,
                               applied, provider_reference, detail)
  VALUES (o.id, 'resolved', 'user', NULL, u, 'unknown', st, true, ref,
          jsonb_build_object(
            'resolution', res,
            'evidence', jsonb_build_object('source', ev_source)
                        || CASE WHEN coalesce(ev_detail, '') <> '' THEN jsonb_build_object('detail', ev_detail)
                                ELSE '{}'::jsonb END,
            'justification', justification));
  RETURN 'resolved';
END $$;

-- Uma tentativa inteira, conduzida como effect-runner.ts conduz: ler,
-- decidir (effect-decision.ts), agir, repetir até 5 rodadas. `behavior`
-- é o provedor falso: success | failure | timeout | crash_before_request |
-- crash_after_request ("crash" = parar sem gravar o fato, como um
-- processo morto).
CREATE OR REPLACE FUNCTION h.eff_attempt(eid uuid, node text, bkey text, op text, fp text,
                                         epoch int, behavior text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE k text := h.eff_key(eid, node, bkey, op); o effect_operations%ROWTYPE; r text; ref text;
BEGIN
  FOR round IN 1..5 LOOP
    SELECT * INTO o FROM effect_operations WHERE idempotency_key = k;
    IF NOT FOUND THEN
      r := h.eff_reserve(eid, node, bkey, op, fp, epoch);
      IF r = 'fenced' THEN RETURN 'fenced'; END IF;
      CONTINUE;
    END IF;
    IF o.owner_epoch > epoch THEN RETURN 'fenced'; END IF;
    IF o.payload_fingerprint <> fp THEN RETURN 'payload_mismatch'; END IF;
    IF o.status = 'succeeded' THEN RETURN 'replay_succeeded'; END IF;
    IF o.status = 'failed' THEN RETURN 'replay_failed'; END IF;
    IF o.status = 'unknown' THEN RETURN 'unknown'; END IF;
    IF o.owner_epoch < epoch THEN
      r := h.eff_adopt(o.id, eid, epoch);
      IF r = 'fenced' THEN RETURN 'fenced'; END IF;
      CONTINUE;
    END IF;
    IF o.status = 'in_flight' THEN RETURN 'unknown'; END IF;       -- reentered_in_flight
    r := h.eff_begin(o.id, eid, epoch);
    IF r = 'fenced' THEN RETURN 'fenced'; END IF;
    IF r = 'stale' THEN CONTINUE; END IF;
    -- ponto sem volta cruzado. A "chamada":
    CASE behavior
      WHEN 'success' THEN
        ref := h.provider_accept(k); PERFORM h.eff_record(o.id, eid, epoch, 'succeeded', ref); RETURN 'succeeded';
      WHEN 'failure' THEN
        PERFORM h.eff_record(o.id, eid, epoch, 'failed', NULL, 'MOCK_REJECTED', 'rejected'); RETURN 'failed';
      WHEN 'timeout' THEN
        PERFORM h.provider_accept(k); PERFORM h.eff_record(o.id, eid, epoch, 'unknown', NULL, NULL, 'timed out');
        RETURN 'unknown';
      WHEN 'crash_after_request' THEN PERFORM h.provider_accept(k); RETURN 'crashed';
      WHEN 'crash_before_request' THEN RETURN 'crashed';
    END CASE;
  END LOOP;
  RETURN 'not_attempted';
END $$;

CREATE OR REPLACE FUNCTION h.eff_op(eid uuid, node text, bkey text, op text) RETURNS effect_operations
LANGUAGE sql AS $$ SELECT * FROM effect_operations WHERE idempotency_key = h.eff_key(eid, node, bkey, op); $$;

-- em ordem de seq: dentro de um DO só há uma transação, então created_at
-- é o mesmo para tudo — e mesmo em produção adopted+unknown dividem now().
CREATE OR REPLACE FUNCTION h.eff_events(opid uuid) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(event || '@' || CASE actor WHEN 'worker' THEN epoch::text ELSE actor END
                    || CASE WHEN applied THEN '' ELSE '(não aplicado)' END, ' ' ORDER BY seq)
    FROM effect_attempts WHERE operation_id = opid;
$$;

SELECT h.seed();
TRUNCATE h.fake_provider_ledger RESTART IDENTITY;
DO $$
DECLARE e uuid; e2 uuid; ep int; ep2 int; ep3 int; o effect_operations%ROWTYPE; o2 effect_operations%ROWTYPE;
        r text; r2 text; k text; ok boolean; n int; shape_a text; shape_b text; ev_a text;
  OP  constant text := 'mock.send_message';
  FP  constant text := 'fp-ola';
  MAX_ATT constant int := 3;
BEGIN
RAISE NOTICE '';
RAISE NOTICE '== 8. Efeitos externos (Fase 10) ==';

-- ---------- o banco segura as invariantes -----------------------------
PERFORM h.check('8.0 chave do harness == chave do effect-key.ts',
  h.eff_key('00000000-0000-4000-8000-000000000001', 'send', 'lead-42', OP),
  '0986e4b28c8b07117775b8ebb9cf3e310444ffcb6fce487bf0f1da25136e11b8');
PERFORM h.check('8.0 ...também com acento (JSON canônico igual)',
  h.eff_key('00000000-0000-4000-8000-000000000001', 'envio', 'reserva-Lençóis-7', OP),
  '81c1276a3e0bf891973ed770a422afcc9671b219d892b1c5f2da90294c496e3f');

e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_reserve(e, 'send', 'lead-1', OP, FP, ep);
o := h.eff_op(e, 'send', 'lead-1', OP);
BEGIN
  UPDATE effect_operations SET status = 'in_flight' WHERE id = o.id;   -- sem began_epoch
  PERFORM h.check('8.0 banco recusa in_flight sem began_epoch', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('8.0 banco recusa in_flight sem began_epoch', 'CHECK violation', 'CHECK violation');
END;
BEGIN
  UPDATE effect_operations SET status = 'reserved', began_epoch = 1 WHERE id = o.id;
  PERFORM h.check('8.0 banco recusa reserved COM began_epoch', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('8.0 banco recusa reserved COM began_epoch', 'CHECK violation', 'CHECK violation');
END;
BEGIN
  UPDATE effect_operations SET status = 'succeeded', began_epoch = 1 WHERE id = o.id;
  PERFORM h.check('8.0 banco recusa reserved -> succeeded (pula o ponto sem volta)', 'permitiu', 'guard');
EXCEPTION WHEN raise_exception THEN
  PERFORM h.check('8.0 banco recusa reserved -> succeeded (pula o ponto sem volta)', 'guard', 'guard');
END;
BEGIN
  UPDATE effect_operations SET status = 'in_flight', began_epoch = 2, owner_epoch = 1 WHERE id = o.id;
  PERFORM h.check('8.0 banco recusa dono atrás de quem começou', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('8.0 banco recusa dono atrás de quem começou', 'CHECK violation', 'CHECK violation');
END;
BEGIN
  INSERT INTO effect_operations (execution_id, workspace_id, node_id, business_key, operation,
    idempotency_key, payload_fingerprint, status, owner_epoch)
  SELECT e, ws, 'send', 'lead-1', OP, o.idempotency_key, FP, 'reserved', 1 FROM h.ctx;
  PERFORM h.check('8.0 UNIQUE: segunda operação com a mesma chave', 'permitiu', 'unique violation');
EXCEPTION WHEN unique_violation THEN
  PERFORM h.check('8.0 UNIQUE: segunda operação com a mesma chave', 'unique violation', 'unique violation');
END;
BEGIN
  INSERT INTO effect_operations (execution_id, workspace_id, node_id, business_key, operation,
    idempotency_key, delivery_policy, payload_fingerprint, status, owner_epoch)
  SELECT e, ws, 'send', 'lead-p', OP, 'k-politica', 'at_least_once', FP, 'reserved', 1 FROM h.ctx;
  PERFORM h.check('8.0 só existe a política at_most_once', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('8.0 só existe a política at_most_once', 'CHECK violation', 'CHECK violation');
END;
BEGIN
  INSERT INTO effect_operations (execution_id, workspace_id, node_id, business_key, operation,
    idempotency_key, payload_fingerprint, status, owner_epoch)
  SELECT e, ws, 'send', '', OP, 'k-vazia', FP, 'reserved', 1 FROM h.ctx;
  PERFORM h.check('8.0 businessKey vazia é recusada', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('8.0 businessKey vazia é recusada', 'CHECK violation', 'CHECK violation');
END;
BEGIN
  UPDATE effect_attempts SET applied = false WHERE operation_id = o.id;
  PERFORM h.check('8.0 histórico é append-only (UPDATE recusado)', 'permitiu', 'trigger');
EXCEPTION WHEN raise_exception THEN
  PERFORM h.check('8.0 histórico é append-only (UPDATE recusado)', 'trigger', 'trigger');
END;
BEGIN
  INSERT INTO effect_attempts (operation_id, event, actor, epoch, to_status, applied)
  VALUES (o.id, 'resolved', 'user', 1, 'failed', true);
  PERFORM h.check('8.0 ator user não carrega época', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('8.0 ator user não carrega época', 'CHECK violation', 'CHECK violation');
END;
-- o GUARD (trigger effect_operations_guard): no-máximo-uma-vez é do esquema,
-- não só do código. Operação em voo, legítima, para as tentativas abaixo.
PERFORM h.eff_begin(o.id, e, ep);
BEGIN
  UPDATE effect_operations SET status = 'reserved', began_epoch = NULL WHERE id = o.id;
  PERFORM h.check('8.0 guard: in_flight -> reserved recusado', 'permitiu', 'guard');
EXCEPTION WHEN raise_exception THEN
  PERFORM h.check('8.0 guard: in_flight -> reserved recusado', 'guard', 'guard');
END;
BEGIN
  UPDATE effect_operations SET began_epoch = 2, owner_epoch = 2 WHERE id = o.id;
  PERFORM h.check('8.0 guard: began_epoch não é reescrito', 'permitiu', 'guard');
EXCEPTION WHEN raise_exception THEN
  PERFORM h.check('8.0 guard: began_epoch não é reescrito', 'guard', 'guard');
END;
BEGIN
  UPDATE effect_operations SET owner_epoch = 0 WHERE id = o.id;
  PERFORM h.check('8.0 guard: owner_epoch não diminui', 'permitiu', 'guard');
EXCEPTION WHEN raise_exception OR check_violation THEN
  PERFORM h.check('8.0 guard: owner_epoch não diminui', 'guard', 'guard');
END;
BEGIN
  UPDATE effect_operations SET idempotency_key = 'outra-chave' WHERE id = o.id;
  PERFORM h.check('8.0 guard: identidade imutável', 'permitiu', 'guard');
EXCEPTION WHEN raise_exception THEN
  PERFORM h.check('8.0 guard: identidade imutável', 'guard', 'guard');
END;
BEGIN
  UPDATE effect_operations SET status = 'succeeded' WHERE id = o.id;            -- sem referência
  PERFORM h.check('8.0 banco recusa succeeded sem referência', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('8.0 banco recusa succeeded sem referência', 'CHECK violation', 'CHECK violation');
END;
BEGIN
  UPDATE effect_operations SET status = 'succeeded', provider_reference = '' WHERE id = o.id;
  PERFORM h.check('8.0 banco recusa succeeded com referência vazia', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('8.0 banco recusa succeeded com referência vazia', 'CHECK violation', 'CHECK violation');
END;
PERFORM h.eff_record(o.id, e, ep, 'succeeded', 'fake-final');                   -- fato: final
BEGIN
  UPDATE effect_operations SET status = 'failed', provider_reference = NULL WHERE id = o.id;
  PERFORM h.check('8.0 guard: resultado do provedor é final', 'permitiu', 'guard');
EXCEPTION WHEN raise_exception THEN
  PERFORM h.check('8.0 guard: resultado do provedor é final', 'guard', 'guard');
END;
BEGIN
  UPDATE effect_operations SET resolved_by_user_id = (SELECT usr FROM h.ctx) WHERE id = o.id;
  PERFORM h.check('8.0 guard: só unknown é resolvido por pessoa', 'permitiu', 'guard');
EXCEPTION WHEN raise_exception THEN
  PERFORM h.check('8.0 guard: só unknown é resolvido por pessoa', 'guard', 'guard');
END;
BEGIN
  DELETE FROM executions WHERE id = e;
  PERFORM h.check('8.0 RESTRICT: apagar execução com efeito', 'permitiu', 'FK violation');
EXCEPTION WHEN foreign_key_violation THEN
  PERFORM h.check('8.0 RESTRICT: apagar execução com efeito', 'FK violation', 'FK violation');
END;
BEGIN
  DELETE FROM workflows WHERE id = (SELECT wf FROM h.ctx);
  PERFORM h.check('8.0 RESTRICT: apagar workflow (cascata) com efeito', 'permitiu', 'FK violation');
EXCEPTION WHEN foreign_key_violation THEN
  PERFORM h.check('8.0 RESTRICT: apagar workflow (cascata) com efeito', 'FK violation', 'FK violation');
END;
PERFORM h.check('8.0 RLS habilitada nas duas tabelas',
  (SELECT string_agg(relname || '=' || relrowsecurity, ',' ORDER BY relname) FROM pg_class
    WHERE relname IN ('effect_operations', 'effect_attempts')),
  'effect_attempts=true,effect_operations=true');
PERFORM h.check('8.0 policies de leitura por membro',
  (SELECT string_agg(policyname, ',' ORDER BY policyname) FROM pg_policies
    WHERE tablename IN ('effect_operations', 'effect_attempts')),
  'effect_attempts_select_member,effect_operations_select_member');
-- K (esquema): nenhuma coluna é capaz de guardar o payload ou credencial
PERFORM h.check('K  colunas de effect_operations (sem payload)',
  (SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns
    WHERE table_name = 'effect_operations'),
  'id,execution_id,workspace_id,node_id,business_key,operation,idempotency_key,delivery_policy,payload_fingerprint,status,owner_epoch,began_epoch,provider_reference,last_error,resolved_by_user_id,created_at,updated_at,resolution');
PERFORM h.check('K  colunas de effect_attempts (sem payload)',
  (SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns
    WHERE table_name = 'effect_attempts'),
  'id,seq,operation_id,event,actor,epoch,actor_user_id,from_status,to_status,applied,provider_reference,detail,created_at');

-- ---------- os sete cenários do MockExternalEffect --------------------
-- success
e := h.create_queued(); ep := h.claim(e);
r := h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep, 'success');
o := h.eff_op(e, 'send', 'lead-42', OP);
PERFORM h.check('success: succeeded, 1 envio no ledger',
  r || '/' || o.status || '/' || h.accepted(o.idempotency_key), 'succeeded/succeeded/1');
PERFORM h.check('success: histórico', h.eff_events(o.id), 'reserved@1 began@1 succeeded@1');
r := h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep, 'success');
PERFORM h.check('success: repetir -> replay, ledger continua 1', r || '/' || h.accepted(o.idempotency_key),
  'replay_succeeded/1');

-- failure
e := h.create_queued(); ep := h.claim(e);
r := h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep, 'failure');
o := h.eff_op(e, 'send', 'lead-42', OP);
PERFORM h.check('failure: failed, ledger vazio', r || '/' || o.status || '/' || (o.last_error->>'code') || '/'
  || h.accepted(o.idempotency_key), 'failed/failed/MOCK_REJECTED/0');
PERFORM h.expire_lease(e); PERFORM h.recover_one(e, MAX_ATT); ep2 := h.claim(e);
r := h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep2, 'success');
PERFORM h.check('failure: nova época -> replay, sem retry', r || '/' || h.accepted(o.idempotency_key), 'replay_failed/0');

-- timeout (aceito) e timeout antes do aceite: o mesmo estado gravado
e := h.create_queued(); ep := h.claim(e);
e2 := h.create_queued(); ep2 := h.claim(e2);
r := h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep, 'timeout');
o := h.eff_op(e, 'send', 'lead-42', OP);
PERFORM h.eff_reserve(e2, 'send', 'lead-42', OP, FP, ep2);
o2 := h.eff_op(e2, 'send', 'lead-42', OP);
PERFORM h.eff_begin(o2.id, e2, ep2);
PERFORM h.eff_record(o2.id, e2, ep2, 'unknown', NULL, NULL, 'timed out');   -- nunca chegou ao provedor
o2 := h.eff_op(e2, 'send', 'lead-42', OP);
shape_a := o.status || '/' || o.owner_epoch || '/' || o.began_epoch || '/' || o.last_error::text;
shape_b := o2.status || '/' || o2.owner_epoch || '/' || o2.began_epoch || '/' || o2.last_error::text;
PERFORM h.check('timeout: unknown; ledger 1 vs 0', r || '/' || h.accepted(o.idempotency_key) || '/'
  || h.accepted(o2.idempotency_key), 'unknown/1/0');
PERFORM h.check('timeout: os dois casos são indistinguíveis no banco', (shape_a = shape_b)::text, 'true');
FOR n IN 1..2 LOOP
  PERFORM h.expire_lease(e); PERFORM h.recover_one(e, MAX_ATT); ep := h.claim(e);
  r := h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep, 'success');
END LOOP;
PERFORM h.check('timeout: unknown é permanente (épocas 2 e 3)', r || '/' || (h.eff_op(e, 'send', 'lead-42', OP)).status
  || '/' || h.accepted(o.idempotency_key), 'unknown/unknown/1');
-- Fase 10.5A: ninguém decide enquanto a execução pode agir por ela
PERFORM h.check('timeout: execução viva -> ninguém resolve',
  h.eff_resolve(o.id, 'confirmed_sent', 'fake-msg-1', 'provider_dashboard', NULL,
                'confirmado no painel do provedor'), 'execution_active:running');
PERFORM h.finish(e, 'error', ep);
r := h.eff_resolve(o.id, 'confirmed_sent', 'fake-msg-1', 'provider_dashboard', NULL,
                   'confirmado no painel do provedor');
PERFORM h.check('timeout: só resolução explícita sai de unknown',
  r || '/' || (h.eff_op(e, 'send', 'lead-42', OP)).status || '/' || (h.eff_op(e, 'send', 'lead-42', OP)).resolution,
  'resolved/succeeded/confirmed_sent');
PERFORM h.check('timeout: resolução registrada pelo usuário',
  (SELECT actor || '/' || (epoch IS NULL)::text || '/' || (actor_user_id = (SELECT usr FROM h.ctx))::text
     FROM effect_attempts WHERE operation_id = o.id AND event = 'resolved'), 'user/true/true');
PERFORM h.check('timeout: resolver de novo é recusado',
  h.eff_resolve(o.id, 'confirmed_not_sent', NULL, 'provider_dashboard', 'nada no painel',
                'mudei de ideia depois de resolver'), 'not_unknown:succeeded');

-- crash-before-request, ANTES do begin (reserva só): a época 2 envia uma vez
e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_reserve(e, 'send', 'lead-42', OP, FP, ep);                  -- e morre aqui
o := h.eff_op(e, 'send', 'lead-42', OP);
PERFORM h.expire_lease(e); PERFORM h.recover_one(e, MAX_ATT); ep2 := h.claim(e);
r := h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep2, 'success');
o2 := h.eff_op(e, 'send', 'lead-42', OP);
PERFORM h.check('crash-before (antes do begin): época 2 envia 1x',
  r || '/' || h.accepted(o.idempotency_key), 'succeeded/1');
PERFORM h.check('B  duas épocas, uma operação',
  (SELECT count(*) FROM effect_operations WHERE execution_id = e)::text || '/' || (o2.id = o.id)::text, '1/true');
PERFORM h.check('H  reclaim não muda a identidade', (o2.idempotency_key = o.idempotency_key)::text, 'true');
PERFORM h.check('D  retry usa a mesma chave (a do reserve da época 1)',
  ((SELECT string_agg(idempotency_key, ',') FROM h.fake_provider_ledger WHERE idempotency_key = o.idempotency_key)
   = o.idempotency_key)::text, 'true');
PERFORM h.check('crash-before (antes do begin): histórico', h.eff_events(o.id),
  'reserved@1 adopted@2 began@2 succeeded@2');

-- crash-before-request, DEPOIS do begin: ninguém envia, unknown
e := h.create_queued(); ep := h.claim(e);
r := h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep, 'crash_before_request');
o := h.eff_op(e, 'send', 'lead-42', OP);
PERFORM h.check('crash-before (após begin): in_flight, ledger 0',
  r || '/' || o.status || '/' || h.accepted(o.idempotency_key), 'crashed/in_flight/0');
PERFORM h.expire_lease(e); PERFORM h.recover_one(e, MAX_ATT); ep2 := h.claim(e);
r := h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep2, 'success');
o := h.eff_op(e, 'send', 'lead-42', OP);
shape_a := o.status || '/' || o.owner_epoch || '/' || o.began_epoch;
ev_a := h.eff_events(o.id);
PERFORM h.check('crash-before (após begin): época 2 NÃO envia',
  r || '/' || shape_a || '/' || h.accepted(o.idempotency_key), 'unknown/unknown/2/1/0');

-- crash-after-request: provedor aceitou; época 2 não reenvia
e := h.create_queued(); ep := h.claim(e);
r := h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep, 'crash_after_request');
PERFORM h.expire_lease(e); PERFORM h.recover_one(e, MAX_ATT); ep2 := h.claim(e);
r := h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep2, 'success');
o := h.eff_op(e, 'send', 'lead-42', OP);
PERFORM h.check('crash-after: época 2 não reenvia -> unknown',
  r || '/' || o.status || '/' || h.accepted(o.idempotency_key), 'unknown/unknown/1');
PERFORM h.check('J  crash-after == crash-before(após begin) no banco',
  ((o.status || '/' || o.owner_epoch || '/' || o.began_epoch) = shape_a AND h.eff_events(o.id) = ev_a)::text, 'true');

-- late-success: a época 1 confirma depois que a 2 já assumiu
e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_reserve(e, 'send', 'lead-42', OP, FP, ep);
o := h.eff_op(e, 'send', 'lead-42', OP);
PERFORM h.eff_begin(o.id, e, ep);
k := h.provider_accept(o.idempotency_key);                                -- aceito; resposta lenta
PERFORM h.expire_lease(e); PERFORM h.recover_one(e, MAX_ATT); ep2 := h.claim(e);
r := h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep2, 'success');
PERFORM h.check('late-success: época 2 vê unknown, não reenvia', r || '/' || h.accepted(o.idempotency_key), 'unknown/1');
ok := h.eff_record(o.id, e, ep, 'succeeded', k);                          -- a resposta chega
o := h.eff_op(e, 'send', 'lead-42', OP);
PERFORM h.check('late-success: fato da época 1 aceito por autoria',
  ok::text || '/' || o.status || '/' || (o.provider_reference = k)::text || '/dono=' || o.owner_epoch, 'true/succeeded/true/dono=2');
PERFORM h.check('late-success: histórico', h.eff_events(o.id),
  'reserved@1 began@1 adopted@2 unknown@2 succeeded@1');
PERFORM h.check('late-success: época 1 não finaliza a execução', (h.finish(e, 'success', ep) IS NULL)::text, 'true');

-- late-success depois de resolução humana: fica no histórico, não reescreve
e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_reserve(e, 'send', 'lead-42', OP, FP, ep);
o := h.eff_op(e, 'send', 'lead-42', OP);
PERFORM h.eff_begin(o.id, e, ep); k := h.provider_accept(o.idempotency_key);
PERFORM h.expire_lease(e); PERFORM h.recover_one(e, MAX_ATT); ep2 := h.claim(e);
PERFORM h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep2, 'success');
PERFORM h.finish(e, 'error', ep2);
PERFORM h.check('late após resolução: a pessoa decide "não enviado"',
  h.eff_resolve(o.id, 'confirmed_not_sent', NULL, 'provider_dashboard', 'nenhuma mensagem para lead-42',
                'não achei no painel do provedor'), 'resolved');
ok := h.eff_record(o.id, e, ep, 'succeeded', k);
PERFORM h.check('late após resolução: o fato do provedor substitui o juízo',
  ok::text || '/' || (h.eff_op(e, 'send', 'lead-42', OP)).status || '/'
  || ((h.eff_op(e, 'send', 'lead-42', OP)).resolved_by_user_id IS NULL)::text || '/'
  || coalesce((h.eff_op(e, 'send', 'lead-42', OP)).resolution, 'NULL'), 'true/succeeded/true/NULL');
PERFORM h.check('late após resolução: histórico guarda os dois', h.eff_events(o.id),
  'reserved@1 began@1 adopted@2 unknown@2 resolved@user succeeded@1');
PERFORM h.check('late após resolução: o fato nomeia o juízo que substituiu',
  (SELECT detail->'overridesResolution'->>'status' || '/' || (detail->'overridesResolution'->>'resolution')
     FROM effect_attempts WHERE operation_id = o.id AND event = 'succeeded'), 'failed/confirmed_not_sent');
-- um fato NUNCA substitui outro fato
ok := h.eff_record(o.id, e, ep, 'failed', NULL, 'LATE', 'contradiz o fato');
PERFORM h.check('   fato não substitui fato', ok::text || '/' || (h.eff_op(e, 'send', 'lead-42', OP)).status,
  'false/succeeded');

-- duplicate-attempt
e := h.create_queued(); ep := h.claim(e);
r := h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep, 'success');
r2 := h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep, 'success');
o := h.eff_op(e, 'send', 'lead-42', OP);
PERFORM h.check('A  duas tentativas da mesma época: 1 operação, 1 envio',
  r || '/' || r2 || '/' || (SELECT count(*) FROM effect_operations WHERE execution_id = e) || '/'
  || h.accepted(o.idempotency_key), 'succeeded/replay_succeeded/1/1');
-- begin repetido na mesma época: o banco não deixa cruzar duas vezes
PERFORM h.check('   begin repetido: stale (began_epoch já gravado)', h.eff_begin(o.id, e, ep), 'stale');

-- zumbi reservou; novo dono assume, envia; zumbi acorda e é fenced
e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_reserve(e, 'send', 'lead-42', OP, FP, ep);
o := h.eff_op(e, 'send', 'lead-42', OP);
PERFORM h.expire_lease(e); PERFORM h.recover_one(e, MAX_ATT); ep2 := h.claim(e);
r := h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep2, 'success');
r2 := h.eff_begin(o.id, e, ep);                                           -- zumbi
PERFORM h.check('duplicate (zumbi + dono): dono envia, zumbi fenced',
  r || '/' || r2 || '/' || h.accepted(o.idempotency_key), 'succeeded/fenced/1');
PERFORM h.check('   zumbi também não reserva operação nova',
  h.eff_reserve(e, 'send', 'lead-99', OP, FP, ep), 'fenced');
PERFORM h.check('   ...e não adota', h.eff_adopt(o.id, e, ep), 'fenced');
PERFORM h.check('   payload diferente na mesma identidade: recusado',
  h.eff_attempt(e, 'send', 'lead-42', OP, 'fp-outro', ep2, 'success'), 'payload_mismatch');

-- ---------- A–K que faltam ------------------------------------------
e := h.create_queued(); ep := h.claim(e); e2 := h.create_queued(); ep2 := h.claim(e2);
PERFORM h.eff_attempt(e, 'send-a', 'lead-42', OP, FP, ep, 'success');
PERFORM h.eff_attempt(e, 'send-b', 'lead-42', OP, FP, ep, 'success');
PERFORM h.eff_attempt(e, 'send-a', 'lead-43', OP, FP, ep, 'success');
PERFORM h.eff_attempt(e2, 'send-a', 'lead-42', OP, FP, ep2, 'success');
PERFORM h.check('E  node diferente -> operação diferente',
  (SELECT count(*) FROM effect_operations WHERE execution_id = e AND business_key = 'lead-42')::text, '2');
PERFORM h.check('F  businessKey diferente -> operação diferente',
  (SELECT count(*) FROM effect_operations WHERE execution_id = e)::text, '3');
PERFORM h.check('G  execuções diferentes não colidem',
  (SELECT count(*) FROM effect_operations WHERE execution_id IN (e, e2))::text || '/'
  || (SELECT count(DISTINCT idempotency_key) FROM effect_operations WHERE execution_id IN (e, e2)), '4/4');

-- I. época antiga não grava fato na operação que a nova começou
e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_reserve(e, 'send', 'lead-42', OP, FP, ep);
o := h.eff_op(e, 'send', 'lead-42', OP);
PERFORM h.expire_lease(e); PERFORM h.recover_one(e, MAX_ATT); ep2 := h.claim(e);
PERFORM h.eff_adopt(o.id, e, ep2); PERFORM h.eff_begin(o.id, e, ep2);     -- época 2 em voo
ok := h.eff_record(o.id, e, ep, 'succeeded', 'forjado-pela-epoca-1');
o := h.eff_op(e, 'send', 'lead-42', OP);
PERFORM h.check('I  época 1 não finaliza operação da época 2',
  ok::text || '/' || o.status || '/' || coalesce(o.provider_reference, 'null'), 'false/in_flight/null');
PERFORM h.check('I  a tentativa fica registrada como não aplicada',
  (SELECT applied::text || '/' || (detail->>'notApplied') FROM effect_attempts
    WHERE operation_id = o.id ORDER BY seq DESC LIMIT 1),
  'false/reported by an epoch that did not make the call');
ok := h.eff_record(o.id, e, ep2, 'succeeded', 'fake-epoca-2');
PERFORM h.check('I  a época 2 conclui normalmente', ok::text || '/' || (h.eff_op(e, 'send', 'lead-42', OP)).status,
  'true/succeeded');

-- J. término com operação em voo -> unknown (trigger), qualquer caminho
e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep, 'crash_before_request');   -- in_flight
PERFORM h.eff_reserve(e, 'send', 'lead-43', OP, FP, ep);                           -- reserved
PERFORM h.finish(e, 'error', ep);                          -- worker termina sem ter gravado o fato
PERFORM h.check('J  finish com operação em voo: vira unknown',
  (h.eff_op(e, 'send', 'lead-42', OP)).status || '/' || (h.eff_op(e, 'send', 'lead-43', OP)).status, 'unknown/reserved');
PERFORM h.check('J  ...pelo sistema, sem época, com o status da execução',
  (SELECT actor || '/' || coalesce(epoch::text, 'null') || '/' || (detail->>'executionStatus')
     FROM effect_attempts WHERE operation_id = (h.eff_op(e, 'send', 'lead-42', OP)).id AND actor = 'system'),
  'system/null/error');

e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep, 'crash_after_request');
FOR n IN 2..MAX_ATT LOOP                                   -- épocas 2 e 3 morrem antes do nó
  PERFORM h.expire_lease(e); PERFORM h.recover_one(e, MAX_ATT); PERFORM h.claim(e);
END LOOP;
PERFORM h.expire_lease(e);
r := h.recover_one(e, MAX_ATT);
PERFORM h.check('J  reaper abandona com operação em voo: vira unknown',
  r || '/' || (h.eff_op(e, 'send', 'lead-42', OP)).status, 'abandoned/unknown');
ok := h.eff_record((h.eff_op(e, 'send', 'lead-42', OP)).id, e, 1, 'succeeded', 'fake-tardio');
PERFORM h.check('   fato tardio da época 1 ainda vale depois do abandono',
  ok::text || '/' || (h.eff_op(e, 'send', 'lead-42', OP)).status, 'true/succeeded');

e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep, 'crash_before_request');
PERFORM h.expire_lease(e); PERFORM h.recover_one(e, MAX_ATT);
PERFORM h.check('   reclaim (running -> queued) NÃO dispara o trigger',
  (h.eff_op(e, 'send', 'lead-42', OP)).status, 'in_flight');

e := h.create_sync();
PERFORM h.check('   execução síncrona: reserve é fenced (runner=request)',
  h.eff_reserve(e, 'send', 'lead-42', OP, FP, 0), 'fenced');
PERFORM h.check('   ...e o finish síncrono passa com o trigger no caminho',
  (h.finish_sync(e, 'success') IS NOT NULL)::text, 'true');

-- #3 da revisão: cancelada NA FILA (depois de um reclaim) com operação em voo
e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep, 'crash_after_request');
PERFORM h.expire_lease(e); PERFORM h.recover_one(e, MAX_ATT);                  -- queued
UPDATE executions SET status = 'cancelled', finished_at = now() WHERE id = e;
PERFORM h.check('J  queued -> cancelled com operação em voo: vira unknown',
  (h.eff_op(e, 'send', 'lead-42', OP)).status, 'unknown');

-- #6 da revisão: autoria e posse presas à execução, não só ao número da época
e := h.create_queued(); ep := h.claim(e);                                       -- época 1
e2 := h.create_queued(); ep2 := h.claim(e2);                                     -- também época 1
PERFORM h.eff_reserve(e2, 'send', 'lead-42', OP, FP, ep2);
o2 := h.eff_op(e2, 'send', 'lead-42', OP);
PERFORM h.check('   época 1 de OUTRA execução não inicia a operação', h.eff_begin(o2.id, e, ep), 'fenced');
PERFORM h.eff_begin(o2.id, e2, ep2);
ok := h.eff_record(o2.id, e, ep, 'succeeded', 'forjado-por-outra-execucao');
PERFORM h.check('   ...nem grava fato nela', ok::text || '/' || (h.eff_op(e2, 'send', 'lead-42', OP)).status,
  'false/in_flight');

-- #5 da revisão: resolver como succeeded exige referência
e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep, 'timeout');
PERFORM h.finish(e, 'error', ep);
BEGIN   -- a API (zod) recusa antes; aqui, o banco por baixo dela
  PERFORM h.eff_resolve((h.eff_op(e, 'send', 'lead-42', OP)).id, 'confirmed_sent', '', 'provider_dashboard',
                        NULL, 'vi no painel do provedor');
  PERFORM h.check('   resolução confirmed_sent sem referência recusada', 'permitiu', 'recusado');
EXCEPTION WHEN raise_exception OR check_violation THEN
  PERFORM h.check('   resolução confirmed_sent sem referência recusada', 'recusado', 'recusado');
END;

-- ---------- retenção: apagar é uma decisão explícita -----------------
e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_attempt(e, 'send', 'lead-42', OP, FP, ep, 'success');
PERFORM h.finish(e, 'success', ep);
DELETE FROM effect_attempts WHERE operation_id IN (SELECT id FROM effect_operations WHERE execution_id = e);
DELETE FROM effect_operations WHERE execution_id = e;
DELETE FROM executions WHERE id = e;
PERFORM h.check('   purga deliberada: histórico -> operação -> execução',
  (SELECT count(*) FROM executions WHERE id = e)::text, '0');

RAISE NOTICE '';
END $$;

-- =====================================================================
-- Seção 9 — arquivar workflow; resolver "unknown" com evidência (Fase 10.5A)
--
-- Transcrições de server/workflows/mutations.ts (archive, restore, update,
-- delete) e de listEffectOperations (effect-repository.ts); a resolução é
-- h.eff_resolve, na seção 8. A checagem de membro é a
-- requireWorkspaceMembership de sempre — aqui, só a transação.
--
-- O que os triggers e CHECKs da 0007 garantem é exercido TAMBÉM direto no
-- banco, sem passar por transcrição nenhuma: a garantia tem de valer para
-- qualquer escrita, não só para a do código.
--
-- A corrida real entre duas sessões (arquivar x executar, duas pessoas
-- resolvendo, resolução x fato tardio) está em concurrency-check.sh,
-- cenários 7–9.
--
-- Armadilha de leitura: uma subquery enxerga o snapshot do comando em que
-- está — tirado ANTES de uma função no mesmo comando escrever. Por isso
-- todo "escreve, depois confere o que foi escrito" abaixo são DOIS
-- comandos (r := ...; depois o check). Funções h.* (voláteis) tiram
-- snapshot próprio e não têm esse problema.
-- =====================================================================

-- archiveWorkflow — trava o workflow (FOR UPDATE); recusa com execução do
-- WORKER queued/running; WK002 (trigger) é o backstop, mapeado igual.
CREATE OR REPLACE FUNCTION h.wf_archive(wid uuid, who uuid DEFAULT NULL, ws_in uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE w workflows%ROWTYPE; u uuid := coalesce(who, (SELECT usr FROM h.ctx));
        wsid uuid := coalesce(ws_in, (SELECT ws FROM h.ctx));
BEGIN
  SELECT * INTO w FROM workflows WHERE id = wid AND workspace_id = wsid LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF w.archived_at IS NOT NULL THEN RETURN 'already_archived'; END IF;
  PERFORM 1 FROM executions WHERE workflow_id = wid AND runner = 'worker' AND status IN ('queued', 'running') LIMIT 1;
  IF FOUND THEN RETURN 'WORKFLOW_HAS_ACTIVE_EXECUTIONS'; END IF;
  UPDATE workflows SET archived_at = now(), archived_by = u, updated_at = now()
   WHERE id = wid AND archived_at IS NULL;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  RETURN 'archived';
EXCEPTION WHEN SQLSTATE 'WK002' THEN
  RETURN 'WORKFLOW_HAS_ACTIVE_EXECUTIONS';
END $$;

-- restoreWorkflow — `status` não é tocado
CREATE OR REPLACE FUNCTION h.wf_restore(wid uuid, ws_in uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE w workflows%ROWTYPE; wsid uuid := coalesce(ws_in, (SELECT ws FROM h.ctx));
BEGIN
  SELECT * INTO w FROM workflows WHERE id = wid AND workspace_id = wsid LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF w.archived_at IS NULL THEN RETURN 'not_archived'; END IF;
  UPDATE workflows SET archived_at = NULL, archived_by = NULL, updated_at = now()
   WHERE id = wid AND archived_at IS NOT NULL;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  RETURN 'restored';
END $$;

-- updateWorkflow — arquivado é somente leitura
CREATE OR REPLACE FUNCTION h.wf_update(wid uuid, new_name text, ws_in uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE w workflows%ROWTYPE; wsid uuid := coalesce(ws_in, (SELECT ws FROM h.ctx));
BEGIN
  SELECT * INTO w FROM workflows WHERE id = wid AND workspace_id = wsid LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF w.archived_at IS NOT NULL THEN RETURN 'WORKFLOW_ARCHIVED'; END IF;
  UPDATE workflows SET name = new_name, updated_at = now()
   WHERE id = wid AND workspace_id = wsid AND archived_at IS NULL;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  RETURN 'updated';
END $$;

-- deleteWorkflow — só sem histórico de efeito; a FK (RESTRICT) é o backstop
CREATE OR REPLACE FUNCTION h.wf_delete(wid uuid, ws_in uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE wsid uuid := coalesce(ws_in, (SELECT ws FROM h.ctx)); d uuid;
BEGIN
  PERFORM 1 FROM workflows WHERE id = wid AND workspace_id = wsid LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  PERFORM 1 FROM effect_operations o JOIN executions x ON x.id = o.execution_id
   WHERE x.workflow_id = wid LIMIT 1;
  IF FOUND THEN RETURN 'WORKFLOW_HAS_EFFECT_HISTORY'; END IF;
  DELETE FROM workflows WHERE id = wid AND workspace_id = wsid RETURNING id INTO d;
  IF d IS NULL THEN RETURN 'not_found'; END IF;
  RETURN 'deleted';
EXCEPTION WHEN foreign_key_violation THEN
  RETURN 'WORKFLOW_HAS_EFFECT_HISTORY';
END $$;

-- a execução nova, do ponto de vista do banco: ou a linha nasce, ou o
-- trigger da 0007 a recusa (WK001 -> 409 WORKFLOW_ARCHIVED no TypeScript,
-- via refusingArchived). Usada pelos cenários de corrida.
CREATE OR REPLACE FUNCTION h.try_enqueue() RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM h.create_queued();
  RETURN 'enqueued';
EXCEPTION WHEN SQLSTATE 'WK001' THEN
  RETURN 'WK001';
END $$;

-- listWorkflows — ativos por padrão; arquivados só quando pedidos
CREATE OR REPLACE FUNCTION h.wf_list(archived boolean DEFAULT false) RETURNS SETOF uuid LANGUAGE sql AS $$
  SELECT id FROM workflows
   WHERE workspace_id = (SELECT ws FROM h.ctx)
     AND CASE WHEN archived THEN archived_at IS NOT NULL ELSE archived_at IS NULL END
   ORDER BY updated_at DESC;
$$;

-- listEffectOperations — por padrão, os que esperam uma pessoa
CREATE OR REPLACE FUNCTION h.eff_list(st text DEFAULT 'unknown')
RETURNS TABLE (id uuid, status text, execution_status text, workflow_name text, began_at timestamptz)
LANGUAGE sql AS $$
  SELECT o.id, o.status, x.status, w.name,
         (SELECT min(a.created_at) FROM effect_attempts a WHERE a.operation_id = o.id AND a.event = 'began')
    FROM effect_operations o
    JOIN executions x ON x.id = o.execution_id
    JOIN workflows w ON w.id = x.workflow_id
   WHERE o.workspace_id = (SELECT ws FROM h.ctx)
     AND (st IS NULL OR o.status = st)
   ORDER BY o.updated_at DESC
   LIMIT 50;
$$;

-- um "unknown" pronto para ser resolvido: a chamada cruzou o ponto sem
-- volta (timeout) e a execução terminou.
CREATE OR REPLACE FUNCTION h.unknown_op(bkey text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE e uuid := h.create_queued(); ep int := h.claim(e);
BEGIN
  PERFORM h.eff_attempt(e, 'send', bkey, 'mock.send_message', 'fp', ep, 'timeout');
  PERFORM h.finish(e, 'error', ep);
  RETURN (h.eff_op(e, 'send', bkey, 'mock.send_message')).id;
END $$;

SELECT h.seed();
TRUNCATE h.fake_provider_ledger RESTART IDENTITY;
DO $$
DECLARE wf uuid := (SELECT wf FROM h.ctx); usr uuid := (SELECT usr FROM h.ctx); ws uuid := (SELECT ws FROM h.ctx);
        wf2 uuid; e uuid; e2 uuid; ep int; ep2 int; r text; n int; opid uuid; opid2 uuid;
        o effect_operations%ROWTYPE; member_u uuid := gen_random_uuid(); admin_u uuid := gen_random_uuid();
        stranger uuid := gen_random_uuid(); ws2 uuid; owner2 uuid := gen_random_uuid();
        counts_before text; counts_after text; ok boolean;
  OP constant text := 'mock.send_message';
BEGIN
RAISE NOTICE '';
RAISE NOTICE '== 9. Arquivar workflow; resolver unknown (Fase 10.5A) ==';

-- ---------- esquema --------------------------------------------------
PERFORM h.check('9.0 colunas novas',
  (SELECT string_agg(table_name || '.' || column_name, ',' ORDER BY table_name, column_name)
     FROM information_schema.columns
    WHERE (table_name = 'workflows' AND column_name IN ('archived_at', 'archived_by'))
       OR (table_name = 'effect_operations' AND column_name = 'resolution')),
  'effect_operations.resolution,workflows.archived_at,workflows.archived_by');
PERFORM h.check('9.0 triggers novos',
  (SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger
    WHERE tgname IN ('executions_refuse_archived_workflow', 'workflows_refuse_archive_with_active_executions')),
  'executions_refuse_archived_workflow,workflows_refuse_archive_with_active_executions');
PERFORM h.check('9.0 RLS continua habilitada (workflows, executions, efeitos)',
  (SELECT string_agg(relname || '=' || relrowsecurity, ',' ORDER BY relname) FROM pg_class
    WHERE relname IN ('workflows', 'executions', 'effect_operations', 'effect_attempts')),
  'effect_attempts=true,effect_operations=true,executions=true,workflows=true');
PERFORM h.check('9.0 efeitos NÃO ganham archived_at (são prova, não se arquivam)',
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name IN ('effect_operations', 'effect_attempts', 'executions') AND column_name LIKE 'archived%')::text,
  '0');
BEGIN
  UPDATE workflows SET archived_at = now() WHERE id = wf;          -- sem archived_by
  PERFORM h.check('9.0 archived_at sem archived_by recusado', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('9.0 archived_at sem archived_by recusado', 'CHECK violation', 'CHECK violation');
END;

-- ---------- 9A. arquivar / restaurar / editar / apagar ---------------
UPDATE workflows SET status = 'active' WHERE id = wf;
PERFORM h.check('9A arquivar workflow sem execução', h.wf_archive(wf), 'archived');
PERFORM h.check('9A ...guarda quem arquivou; status (active) intocado',
  (SELECT (archived_by = usr)::text || '/' || status FROM workflows WHERE id = wf), 'true/active');
PERFORM h.check('9A arquivar de novo: idempotente', h.wf_archive(wf), 'already_archived');
PERFORM h.check('9A sai da lista ativa, entra na de arquivados',
  (SELECT count(*) FROM h.wf_list(false) x WHERE x = wf) || '/' || (SELECT count(*) FROM h.wf_list(true) x WHERE x = wf),
  '0/1');
BEGIN
  PERFORM h.create_queued();
  PERFORM h.check('9A arquivado não recebe execução (fila)', 'permitiu', 'WK001');
EXCEPTION WHEN SQLSTATE 'WK001' THEN
  PERFORM h.check('9A arquivado não recebe execução (fila)', 'WK001', 'WK001');
END;
BEGIN
  PERFORM h.create_sync();
  PERFORM h.check('9A arquivado não recebe execução (síncrona)', 'permitiu', 'WK001');
EXCEPTION WHEN SQLSTATE 'WK001' THEN
  PERFORM h.check('9A arquivado não recebe execução (síncrona)', 'WK001', 'WK001');
END;
r := h.wf_update(wf, 'renomeado');
PERFORM h.check('9A arquivado é somente leitura', r || '/' || (SELECT name FROM workflows WHERE id = wf),
  'WORKFLOW_ARCHIVED/wf');
PERFORM h.check('9A outro workspace não arquiva/restaura', h.wf_archive(wf, NULL, gen_random_uuid()) || '/'
  || h.wf_restore(wf, gen_random_uuid()), 'not_found/not_found');
PERFORM h.check('9A restaurar', h.wf_restore(wf), 'restored');
PERFORM h.check('9A ...volta como era (status active, sem archived_*)',
  (SELECT status || '/' || (archived_at IS NULL)::text || '/' || (archived_by IS NULL)::text FROM workflows WHERE id = wf),
  'active/true/true');
PERFORM h.check('9A restaurar de novo', h.wf_restore(wf), 'not_archived');
e := h.create_queued();
PERFORM h.check('9A restaurado recebe execução de novo', (e IS NOT NULL)::text, 'true');
PERFORM h.check('9A execução queued impede arquivar', h.wf_archive(wf), 'WORKFLOW_HAS_ACTIVE_EXECUTIONS');
ep := h.claim(e);
PERFORM h.check('9A execução running impede arquivar', h.wf_archive(wf), 'WORKFLOW_HAS_ACTIVE_EXECUTIONS');
BEGIN   -- o backstop: escrita direta, sem a checagem do repositório
  UPDATE workflows SET archived_at = now(), archived_by = usr WHERE id = wf;
  PERFORM h.check('9A backstop WK002 (UPDATE direto com execução viva)', 'permitiu', 'WK002');
EXCEPTION WHEN SQLSTATE 'WK002' THEN
  PERFORM h.check('9A backstop WK002 (UPDATE direto com execução viva)', 'WK002', 'WK002');
END;
PERFORM h.check('9A ...e a execução não foi afetada', (SELECT status FROM executions WHERE id = e), 'running');
PERFORM h.eff_attempt(e, 'send', 'lead-42', OP, 'fp', ep, 'success');     -- um efeito real (falso)
PERFORM h.finish(e, 'success', ep);
PERFORM h.check('9A apagar workflow com histórico de efeito: recusado', h.wf_delete(wf), 'WORKFLOW_HAS_EFFECT_HISTORY');
counts_before := (SELECT count(*) FROM executions WHERE workflow_id = wf) || '/'
  || (SELECT count(*) FROM effect_operations eo JOIN executions x ON x.id = eo.execution_id WHERE x.workflow_id = wf) || '/'
  || (SELECT count(*) FROM effect_attempts a JOIN effect_operations eo ON eo.id = a.operation_id
        JOIN executions x ON x.id = eo.execution_id WHERE x.workflow_id = wf);
PERFORM h.check('9A execução terminada: arquivar pode', h.wf_archive(wf), 'archived');
counts_after := (SELECT count(*) FROM executions WHERE workflow_id = wf) || '/'
  || (SELECT count(*) FROM effect_operations eo JOIN executions x ON x.id = eo.execution_id WHERE x.workflow_id = wf) || '/'
  || (SELECT count(*) FROM effect_attempts a JOIN effect_operations eo ON eo.id = a.operation_id
        JOIN executions x ON x.id = eo.execution_id WHERE x.workflow_id = wf);
PERFORM h.check('9A arquivar preserva execuções, operações e histórico', counts_after, counts_before);
PERFORM h.check('9A ...e o histórico continua legível (lista de efeitos)',
  (SELECT count(*) FROM h.eff_list(NULL) l WHERE l.workflow_name = 'wf')::text, '1');
PERFORM h.check('9A apagar o arquivado também é recusado', h.wf_delete(wf), 'WORKFLOW_HAS_EFFECT_HISTORY');
INSERT INTO workflows (workspace_id, name, document, created_by)
  VALUES (ws, 'wf-sem-efeito', '{"schemaVersion":1,"nodes":[],"edges":[],"settings":{}}'::jsonb, usr)
  RETURNING id INTO wf2;
r := h.wf_delete(wf2);
PERFORM h.check('9A apagar workflow SEM histórico de efeito: apaga',
  r || '/' || (SELECT count(*) FROM workflows WHERE id = wf2), 'deleted/0');
PERFORM h.check('9A apagar inexistente', h.wf_delete(gen_random_uuid()), 'not_found');
PERFORM h.wf_restore(wf);
-- execução síncrona que ficou "running" para sempre (a request morreu no
-- meio; o caminho síncrono não tem recuperação, por desenho): não pode
-- travar o arquivamento — ela não tem como causar efeito externo.
e := h.create_sync();
r := h.wf_archive(wf);
PERFORM h.check('9A execução síncrona "running" para sempre não trava o arquivamento',
  r || '/' || (SELECT status FROM executions WHERE id = e), 'archived/running');
PERFORM h.wf_restore(wf);
PERFORM h.finish_sync(e, 'error');

-- ---------- 9B. resolver um unknown ----------------------------------
INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (ws, member_u, 'member'), (ws, admin_u, 'admin');
INSERT INTO workspaces (name) VALUES ('harness-2') RETURNING id INTO ws2;
INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (ws2, owner2, 'owner');

e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_attempt(e, 'send', 'lead-7', OP, 'fp', ep, 'timeout');
o := h.eff_op(e, 'send', 'lead-7', OP);
PERFORM h.check('9B a lista de unknown mostra a operação',
  (SELECT count(*) FROM h.eff_list() l WHERE l.id = o.id)::text, '1');
PERFORM h.check('9B execução viva: ninguém resolve',
  h.eff_resolve(o.id, 'confirmed_not_sent', NULL, 'provider_dashboard', 'nada para lead-7',
                'conferi no painel do provedor'), 'execution_active:running');
PERFORM h.finish(e, 'error', ep);
PERFORM h.check('9B membro comum não decide (lê, mas não resolve)',
  h.eff_resolve(o.id, 'confirmed_not_sent', NULL, 'provider_dashboard', 'nada para lead-7',
                'conferi no painel do provedor', 0, member_u), 'forbidden');
BEGIN
  PERFORM h.eff_resolve(o.id, 'confirmed_not_sent', NULL, 'provider_dashboard', 'nada para lead-7',
                        'conferi no painel do provedor', 0, stranger);
  PERFORM h.check('9B não-membro: FORBIDDEN', 'permitiu', 'FORBIDDEN');
EXCEPTION WHEN raise_exception THEN
  PERFORM h.check('9B não-membro: FORBIDDEN', split_part(SQLERRM, ':', 1), 'FORBIDDEN');
END;
PERFORM h.check('9B outro workspace não alcança a operação',
  h.eff_resolve(o.id, 'confirmed_not_sent', NULL, 'provider_dashboard', 'nada para lead-7',
                'conferi no painel do provedor', 0, owner2, ws2), 'not_found');
PERFORM h.check('9B resfriamento: cedo demais (600 s)',
  h.eff_resolve(o.id, 'confirmed_not_sent', NULL, 'provider_dashboard', 'nada para lead-7',
                'conferi no painel do provedor', 600), 'too_early');
PERFORM h.check('9B ...recusas não deixam rastro (estado e histórico)',
  (h.eff_op(e, 'send', 'lead-7', OP)).status || '/' || h.eff_events(o.id), 'unknown/reserved@1 began@1 unknown@1');

-- o banco recusa uma resolução sem evidência, por qualquer caminho
BEGIN
  INSERT INTO effect_attempts (operation_id, event, actor, actor_user_id, from_status, to_status, applied, detail)
  VALUES (o.id, 'resolved', 'user', usr, 'unknown', 'failed', true,
          '{"resolution":"confirmed_not_sent","evidence":{"source":"provider_dashboard","detail":"nada lá"}}');
  PERFORM h.check('9B CHECK: resolved sem justificativa', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('9B CHECK: resolved sem justificativa', 'CHECK violation', 'CHECK violation');
  WHEN SQLSTATE 'WK003' THEN   -- passou pela CHECK; só o trigger do item 6c segurou
  PERFORM h.check('9B CHECK: resolved sem justificativa', 'passou pela CHECK', 'CHECK violation');
END;
BEGIN
  INSERT INTO effect_attempts (operation_id, event, actor, actor_user_id, from_status, to_status, applied, detail)
  VALUES (o.id, 'resolved', 'user', usr, 'unknown', 'failed', true,
          '{"resolution":"confirmed_not_sent","evidence":{"source":"achismo","detail":"acho que não foi"},"justification":"tenho quase certeza"}');
  PERFORM h.check('9B CHECK: fonte de evidência que não é o provedor', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('9B CHECK: fonte de evidência que não é o provedor', 'CHECK violation', 'CHECK violation');
  WHEN SQLSTATE 'WK003' THEN   -- passou pela CHECK; só o trigger do item 6c segurou
  PERFORM h.check('9B CHECK: fonte de evidência que não é o provedor', 'passou pela CHECK', 'CHECK violation');
END;
BEGIN
  INSERT INTO effect_attempts (operation_id, event, actor, actor_user_id, from_status, to_status, applied, detail)
  VALUES (o.id, 'resolved', 'user', usr, 'unknown', 'failed', true,
          '{"resolution":"confirmed_not_sent","evidence":{"source":"provider_dashboard"},"justification":"conferi no painel"}');
  PERFORM h.check('9B CHECK: not_sent sem o que foi consultado', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('9B CHECK: not_sent sem o que foi consultado', 'CHECK violation', 'CHECK violation');
  WHEN SQLSTATE 'WK003' THEN   -- passou pela CHECK; só o trigger do item 6c segurou
  PERFORM h.check('9B CHECK: not_sent sem o que foi consultado', 'passou pela CHECK', 'CHECK violation');
END;
BEGIN
  INSERT INTO effect_attempts (operation_id, event, actor, actor_user_id, from_status, to_status, applied, detail)
  VALUES (o.id, 'resolved', 'user', usr, 'unknown', 'succeeded', true,
          '{"resolution":"confirmed_sent","evidence":{"source":"provider_api"},"justification":"a API confirmou o envio"}');
  PERFORM h.check('9B CHECK: confirmed_sent sem referência', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('9B CHECK: confirmed_sent sem referência', 'CHECK violation', 'CHECK violation');
  WHEN SQLSTATE 'WK003' THEN   -- passou pela CHECK; só o trigger do item 6c segurou
  PERFORM h.check('9B CHECK: confirmed_sent sem referência', 'passou pela CHECK', 'CHECK violation');
END;
BEGIN
  INSERT INTO effect_attempts (operation_id, event, actor, actor_user_id, from_status, to_status, applied, detail)
  VALUES (o.id, 'resolved', 'user', usr, 'unknown', 'failed', true,
          '{"resolution":"confirmed_not_sent","evidence":{"source":"provider_dashboard","detail":"nada lá"},"justification":"123456789"}');
  PERFORM h.check('9B CHECK: justificativa de 9 caracteres', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('9B CHECK: justificativa de 9 caracteres', 'CHECK violation', 'CHECK violation');
  WHEN SQLSTATE 'WK003' THEN   -- passou pela CHECK; só o trigger do item 6c segurou
  PERFORM h.check('9B CHECK: justificativa de 9 caracteres', 'passou pela CHECK', 'CHECK violation');
END;
BEGIN   -- o limite de baixo passa (e é desfeito: savepoint). A operação tem de
        -- mostrar a resolução que o fato registra (0007, item 6c).
  UPDATE effect_operations SET status = 'failed', resolved_by_user_id = usr, resolution = 'confirmed_not_sent',
         last_error = '{"code":"RESOLVED_NOT_SENT","message":"1234567890"}' WHERE id = o.id;
  INSERT INTO effect_attempts (operation_id, event, actor, actor_user_id, from_status, to_status, applied, detail)
  VALUES (o.id, 'resolved', 'user', usr, 'unknown', 'failed', true,
          '{"resolution":"confirmed_not_sent","evidence":{"source":"provider_dashboard","detail":"nada."},"justification":"1234567890"}');
  RAISE EXCEPTION 'desfaz';
EXCEPTION WHEN raise_exception THEN
  PERFORM h.check('9B CHECK: 10 caracteres de justificativa e 5 de detalhe passam', SQLERRM, 'desfaz');
END;
BEGIN   -- conta caracteres, não bytes nem unidades UTF-16: 10 emojis são 10
  UPDATE effect_operations SET status = 'failed', resolved_by_user_id = usr, resolution = 'confirmed_not_sent',
         last_error = '{"code":"RESOLVED_NOT_SENT","message":"x"}' WHERE id = o.id;
  INSERT INTO effect_attempts (operation_id, event, actor, actor_user_id, from_status, to_status, applied, detail)
  VALUES (o.id, 'resolved', 'user', usr, 'unknown', 'failed', true,
          '{"resolution":"confirmed_not_sent","evidence":{"source":"provider_dashboard","detail":"😀😀😀😀😀"},"justification":"😀😀😀😀😀😀😀😀😀😀"}');
  RAISE EXCEPTION 'desfaz';
EXCEPTION WHEN raise_exception THEN
  PERFORM h.check('9B CHECK: comprimento em caracteres (o mesmo que o zod conta)', SQLERRM, 'desfaz');
END;
-- a armadilha do NULL: chave ausente não pode passar (coalesce na CHECK).
-- "Passou pela CHECK" conta mesmo quando o trigger do item 6c segura depois.
DECLARE bad record; leaked int := 0;
BEGIN
  FOR bad IN SELECT * FROM (VALUES
      ('user',   '{"justification":"0123456789","evidence":{"source":"provider_dashboard","detail":"abcde"}}'),
      ('user',   '{"resolution":"confirmed_not_sent","justification":"0123456789","evidence":{"detail":"abcde"}}'),
      ('user',   '{"resolution":"confirmed_not_sent","justification":"0123456789","evidence":"acho que sim"}'),
      ('user',   '{"resolution":"confirmed_not_sent","justification":"          ","evidence":{"source":"provider_dashboard","detail":"abcde"}}'),
      ('user',   '{"resolution":"confirmed_not_sent","justification":"0123456789","evidence":{"source":"provider_dashboard","detail":"     "}}'),
      ('user',   '{"resolution":"confirmed_not_sent","evidence":{"source":"provider_dashboard","detail":"abcde"}}'),
      ('worker', '{"resolution":"confirmed_not_sent","justification":"0123456789","evidence":{"source":"provider_dashboard","detail":"abcde"}}')
    ) v(actor, detail)
  LOOP
    BEGIN
      INSERT INTO effect_attempts (operation_id, event, actor, epoch, actor_user_id, from_status, to_status, applied, detail)
      VALUES (o.id, 'resolved', bad.actor, CASE WHEN bad.actor = 'worker' THEN 1 END,
              CASE WHEN bad.actor = 'user' THEN usr END, 'unknown', 'failed', true, bad.detail::jsonb);
      leaked := leaked + 1;
      RAISE WARNING 'CHECK deixou passar: % %', bad.actor, bad.detail;
    EXCEPTION
      WHEN check_violation THEN NULL;
      WHEN SQLSTATE 'WK003' THEN
        leaked := leaked + 1;
        RAISE WARNING 'CHECK deixou passar (o trigger segurou): % %', bad.actor, bad.detail;
    END;
  END LOOP;
  PERFORM h.check('9B CHECK: sem decisão/fonte/justificativa, evidência-texto, só espaços, ator worker',
    leaked::text || ' passaram', '0 passaram');
END;
BEGIN
  UPDATE effect_operations SET resolution = 'confirmed_sent' WHERE id = o.id;
  PERFORM h.check('9B CHECK: resolution sem resolved_by_user_id', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('9B CHECK: resolution sem resolved_by_user_id', 'CHECK violation', 'CHECK violation');
END;
BEGIN
  UPDATE effect_operations SET status = 'failed', resolved_by_user_id = usr, resolution = 'confirmed_sent',
         last_error = '{"code":"X","message":"y"}' WHERE id = o.id;
  PERFORM h.check('9B CHECK: confirmed_sent com status failed', 'permitiu', 'CHECK violation');
EXCEPTION WHEN check_violation THEN
  PERFORM h.check('9B CHECK: confirmed_sent com status failed', 'CHECK violation', 'CHECK violation');
END;

-- a resolução de verdade
r := h.eff_resolve(o.id, 'confirmed_not_sent', NULL, 'provider_dashboard', 'nenhuma mensagem para lead-7',
                   'conferi no painel do provedor às 14h; nada consta');
o := h.eff_op(e, 'send', 'lead-7', OP);
PERFORM h.check('9B confirmed_not_sent -> failed',
  r || '/' || o.status || '/' || o.resolution || '/' || (o.resolved_by_user_id = usr)::text || '/'
  || coalesce(o.provider_reference, 'NULL'), 'resolved/failed/confirmed_not_sent/true/NULL');
PERFORM h.check('9B ...last_error diz que foi uma pessoa, e por quê',
  o.last_error->>'code' || '/' || (o.last_error->>'message'), 'RESOLVED_NOT_SENT/conferi no painel do provedor às 14h; nada consta');
PERFORM h.check('9B ...UM fato resolved, append-only, com evidência',
  (SELECT count(*) || '/' || max(actor) || '/' || bool_and(epoch IS NULL) || '/' || max(from_status || '>' || to_status)
          || '/' || max(detail->>'resolution') || '/' || max(detail->'evidence'->>'source') || '/'
          || max(detail->'evidence'->>'detail')
     FROM effect_attempts WHERE operation_id = o.id AND event = 'resolved'),
  '1/user/true/unknown>failed/confirmed_not_sent/provider_dashboard/nenhuma mensagem para lead-7');
PERFORM h.check('9B ...histórico anterior intacto', h.eff_events(o.id),
  'reserved@1 began@1 unknown@1 resolved@user');
PERFORM h.check('9B sai da lista de unknown', (SELECT count(*) FROM h.eff_list() l WHERE l.id = o.id)::text, '0');
PERFORM h.check('9B resolver de novo: recusado (ninguém sobrescreve ninguém)',
  h.eff_resolve(o.id, 'confirmed_rejected', NULL, 'provider_support', 'o suporte disse outra coisa',
                'o suporte respondeu diferente', 0, admin_u), 'not_unknown:failed');
BEGIN   -- direto no banco: outra pessoa por cima
  UPDATE effect_operations SET resolved_by_user_id = admin_u, resolution = 'confirmed_rejected',
         last_error = '{"code":"RESOLVED_REJECTED","message":"x"}' WHERE id = o.id;
  PERFORM h.check('9B guard: pessoa não sobrescreve pessoa', 'permitiu', 'guard');
EXCEPTION WHEN raise_exception THEN
  PERFORM h.check('9B guard: pessoa não sobrescreve pessoa', 'guard', 'guard');
END;
BEGIN   -- direto no banco: a mesma pessoa mudando de ideia
  UPDATE effect_operations SET resolution = 'confirmed_rejected',
         last_error = '{"code":"RESOLVED_REJECTED","message":"x"}' WHERE id = o.id;
  PERFORM h.check('9B guard: nem a mesma pessoa troca a decisão', 'permitiu', 'guard');
EXCEPTION WHEN raise_exception THEN
  PERFORM h.check('9B guard: nem a mesma pessoa troca a decisão', 'guard', 'guard');
END;
BEGIN
  UPDATE effect_attempts SET detail = detail || '{"justification":"reescrita depois"}'
   WHERE operation_id = o.id AND event = 'resolved';
  PERFORM h.check('9B a justificativa não é reescrita (append-only)', 'permitiu', 'trigger');
EXCEPTION WHEN raise_exception THEN
  PERFORM h.check('9B a justificativa não é reescrita (append-only)', 'trigger', 'trigger');
END;

-- admin decide; confirmed_sent leva a referência para a operação
opid := h.unknown_op('lead-8');
r := h.eff_resolve(opid, 'confirmed_sent', 'prov-123', 'provider_api', NULL, 'GET na API do provedor mostrou entregue',
                   0, admin_u);
PERFORM h.check('9B admin decide: confirmed_sent -> succeeded com a referência',
  r || '/' || (SELECT status || '/' || provider_reference || '/' || resolution || '/' || (resolved_by_user_id = admin_u)::text
                 FROM effect_operations WHERE id = opid),
  'resolved/succeeded/prov-123/confirmed_sent/true');
-- confirmed_rejected: a referência da recusa fica só no fato
opid2 := h.unknown_op('lead-9');
r := h.eff_resolve(opid2, 'confirmed_rejected', 'rej-9', 'provider_webhook', 'webhook de recusa: número inválido',
                   'o provedor recusou: número inválido');
PERFORM h.check('9B confirmed_rejected: referência só no fato, não na operação',
  r || '/'
  || (SELECT status || '/' || coalesce(provider_reference, 'NULL') || '/' || (last_error->>'code') FROM effect_operations WHERE id = opid2)
  || '/' || (SELECT provider_reference FROM effect_attempts WHERE operation_id = opid2 AND event = 'resolved'),
  'resolved/failed/NULL/RESOLVED_REJECTED/rej-9');

-- só "unknown" se resolve
e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_reserve(e, 'send', 'lead-10', OP, 'fp', ep);                 -- reserved, nunca começou
PERFORM h.eff_attempt(e, 'send', 'lead-11', OP, 'fp', ep, 'success');      -- fato do provedor
PERFORM h.finish(e, 'error', ep);
PERFORM h.check('9B reserved (não cruzou o ponto sem volta) não se resolve',
  h.eff_resolve((h.eff_op(e, 'send', 'lead-10', OP)).id, 'confirmed_not_sent', NULL, 'provider_dashboard',
                'nada lá', 'nunca foi enviado de fato'), 'not_unknown:reserved');
PERFORM h.check('9B desfecho do provedor é final: não se resolve',
  h.eff_resolve((h.eff_op(e, 'send', 'lead-11', OP)).id, 'confirmed_not_sent', NULL, 'provider_dashboard',
                'nada lá', 'discordo do provedor'), 'not_unknown:succeeded');
PERFORM h.check('9B operação inexistente', h.eff_resolve(gen_random_uuid(), 'confirmed_not_sent', NULL,
  'provider_dashboard', 'nada lá', 'não existe mesmo'), 'not_found');

-- ---------- 9C. o fato do provedor prevalece sobre a decisão ----------
-- (1) a pessoa disse "enviado"; o provedor responde "falhou": vale o provedor
e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_reserve(e, 'send', 'lead-20', OP, 'fp', ep);
o := h.eff_op(e, 'send', 'lead-20', OP);
PERFORM h.eff_begin(o.id, e, ep);                                           -- a chamada fica pendente
PERFORM h.expire_lease(e); PERFORM h.recover_one(e, 3); ep2 := h.claim(e);
PERFORM h.eff_attempt(e, 'send', 'lead-20', OP, 'fp', ep2, 'success');      -- -> unknown
PERFORM h.finish(e, 'error', ep2);
PERFORM h.eff_resolve(o.id, 'confirmed_sent', 'prov-palpite', 'provider_dashboard', NULL, 'parecia estar no painel');
ok := h.eff_record(o.id, e, ep, 'failed', NULL, 'PROVIDER_REJECTED', 'número inválido');
PERFORM h.check('9C provedor contradiz a pessoa: o fato substitui a decisão',
  ok::text || '/'
  || (SELECT status || '/' || coalesce(provider_reference, 'NULL') || '/' || coalesce(resolution, 'NULL') || '/'
             || (resolved_by_user_id IS NULL)::text || '/' || (last_error->>'code') FROM effect_operations WHERE id = o.id),
  'true/failed/NULL/NULL/true/PROVIDER_REJECTED');
PERFORM h.check('9C ...o histórico guarda os dois, e nomeia o que foi substituído',
  h.eff_events(o.id) || ' | ' || (SELECT (detail->'overridesResolution'->>'resolution') || '/'
     || (detail->'overridesResolution'->>'status') FROM effect_attempts WHERE operation_id = o.id AND event = 'failed'),
  'reserved@1 began@1 adopted@2 unknown@2 resolved@user failed@1 | confirmed_sent/succeeded');
-- (2) o provedor CONCORDA com a pessoa: ainda assim vira a palavra do provedor
e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_reserve(e, 'send', 'lead-21', OP, 'fp', ep);
o := h.eff_op(e, 'send', 'lead-21', OP);
PERFORM h.eff_begin(o.id, e, ep);
PERFORM h.finish(e, 'error', ep);                                           -- trigger: in_flight -> unknown
PERFORM h.eff_resolve(o.id, 'confirmed_sent', 'prov-21', 'provider_dashboard', NULL, 'está no painel do provedor');
ok := h.eff_record(o.id, e, ep, 'succeeded', 'prov-21');
PERFORM h.check('9C provedor confirma: o estado passa a ser atestado pelo provedor',
  ok::text || '/'
  || (SELECT status || '/' || provider_reference || '/' || coalesce(resolution, 'NULL') || '/' || (resolved_by_user_id IS NULL)::text
        FROM effect_operations WHERE id = o.id), 'true/succeeded/prov-21/NULL/true');
-- (3) o que NÃO substitui uma decisão
e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_reserve(e, 'send', 'lead-22', OP, 'fp', ep);
o := h.eff_op(e, 'send', 'lead-22', OP);
PERFORM h.eff_begin(o.id, e, ep);
PERFORM h.finish(e, 'error', ep);
PERFORM h.eff_resolve(o.id, 'confirmed_not_sent', NULL, 'provider_dashboard', 'nada para lead-22',
                      'conferi no painel do provedor');
ok := h.eff_record(o.id, e, ep, 'unknown', NULL, NULL, 'timed out');
PERFORM h.check('9C um "unknown" tardio não desfaz a decisão',
  ok::text || '/'
  || (SELECT status || '/' || resolution FROM effect_operations WHERE id = o.id), 'false/failed/confirmed_not_sent');
ok := h.eff_record(o.id, e, ep + 1, 'succeeded', 'forjado');
PERFORM h.check('9C fato de uma época que não fez a chamada não a desfaz',
  ok::text || '/'
  || (SELECT status || '/' || resolution FROM effect_operations WHERE id = o.id), 'false/failed/confirmed_not_sent');
PERFORM h.check('9C ...e os dois ficam no histórico, marcados como não aplicados', h.eff_events(o.id),
  'reserved@1 began@1 unknown@system resolved@user unknown@1(não aplicado) succeeded@2(não aplicado)');
ok := h.eff_record(o.id, e, ep, 'succeeded', 'prov-22');
PERFORM h.check('9C depois do fato, nova decisão humana é recusada',
  ok::text || '/'
  || h.eff_resolve(o.id, 'confirmed_not_sent', NULL, 'provider_dashboard', 'nada para lead-22', 'insisto que não foi'),
  'true/not_unknown:succeeded');
BEGIN   -- e direto no banco: fato do provedor é final, pessoa não o reescreve
  UPDATE effect_operations SET status = 'failed', provider_reference = NULL, resolved_by_user_id = usr,
         resolution = 'confirmed_not_sent', last_error = '{"code":"RESOLVED_NOT_SENT","message":"x"}' WHERE id = o.id;
  PERFORM h.check('9C guard: pessoa não reescreve fato do provedor', 'permitiu', 'guard');
EXCEPTION WHEN raise_exception THEN
  PERFORM h.check('9C guard: pessoa não reescreve fato do provedor', 'guard', 'guard');
END;

-- ---------- 9D. arquivar não trava a resolução ------------------------
opid := h.unknown_op('lead-30');
PERFORM h.check('9D workflow com unknown pendente pode ser arquivado', h.wf_archive(wf), 'archived');
PERFORM h.check('9D ...o unknown continua na lista', (SELECT count(*) FROM h.eff_list() l WHERE l.id = opid)::text, '1');
PERFORM h.check('9D ...e continua resolvível (a prova não depende do workflow estar ativo)',
  h.eff_resolve(opid, 'confirmed_not_sent', NULL, 'provider_api', 'GET /messages?key=... vazio',
                'a API do provedor não tem a mensagem'), 'resolved');
PERFORM h.wf_restore(wf);

-- ---------- 9E. a decisão e o seu registro são inseparáveis (0007, 6) ----
-- (a)/(b) são checadas no COMMIT; aqui, SET CONSTRAINTS ... IMMEDIATE faz o
-- que o commit faria, dentro de um bloco que dá para desfazer.
opid := h.unknown_op('lead-60');
BEGIN
  UPDATE effect_operations SET status = 'failed', resolved_by_user_id = usr, resolution = 'confirmed_not_sent',
         last_error = '{"code":"RESOLVED_NOT_SENT","message":"x"}' WHERE id = opid;
  SET CONSTRAINTS "effect_operations_resolution_is_recorded" IMMEDIATE;
  PERFORM h.check('9E resolução sem o fato resolved: recusada no commit', 'permitiu', 'WK003');
EXCEPTION WHEN SQLSTATE 'WK003' THEN
  PERFORM h.check('9E resolução sem o fato resolved: recusada no commit',
    CASE WHEN SQLERRM LIKE '%must be recorded%' THEN 'WK003' ELSE SQLERRM END, 'WK003');
END;
SET CONSTRAINTS "effect_operations_resolution_is_recorded" DEFERRED;

e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_attempt(e, 'send', 'lead-61', OP, 'fp', ep, 'timeout');
opid2 := (h.eff_op(e, 'send', 'lead-61', OP)).id;
BEGIN
  UPDATE effect_operations SET status = 'failed', resolved_by_user_id = usr, resolution = 'confirmed_not_sent',
         last_error = '{"code":"RESOLVED_NOT_SENT","message":"x"}' WHERE id = opid2;
  INSERT INTO effect_attempts (operation_id, event, actor, actor_user_id, from_status, to_status, applied, detail)
  VALUES (opid2, 'resolved', 'user', usr, 'unknown', 'failed', true,
          '{"resolution":"confirmed_not_sent","evidence":{"source":"provider_dashboard","detail":"nada consta"},"justification":"conferi no painel do provedor"}');
  SET CONSTRAINTS "effect_operations_resolution_is_recorded" IMMEDIATE;
  PERFORM h.check('9E ...com o fato, mas com a execução viva: recusada', 'permitiu', 'WK003');
EXCEPTION WHEN SQLSTATE 'WK003' THEN
  PERFORM h.check('9E ...com o fato, mas com a execução viva: recusada',
    CASE WHEN SQLERRM LIKE '%execution has ended%' THEN 'WK003' ELSE SQLERRM END, 'WK003');
END;
SET CONSTRAINTS "effect_operations_resolution_is_recorded" DEFERRED;
PERFORM h.finish(e, 'error', ep);

r := h.eff_resolve(opid, 'confirmed_not_sent', NULL, 'provider_dashboard', 'nada para lead-60', 'conferi no painel do provedor');
BEGIN   -- o caminho legítimo, checado agora (e todas as resoluções anteriores deste bloco junto)
  SET CONSTRAINTS "effect_operations_resolution_is_recorded" IMMEDIATE;
  PERFORM h.check('9E o caminho legítimo passa pelo mesmo teste', r, 'resolved');
EXCEPTION WHEN SQLSTATE 'WK003' THEN
  PERFORM h.check('9E o caminho legítimo passa pelo mesmo teste', SQLERRM, 'resolved');
END;
SET CONSTRAINTS "effect_operations_resolution_is_recorded" DEFERRED;

BEGIN   -- (b) "lavar" a decisão de uma pessoa num estado que parece do provedor
  UPDATE effect_operations SET status = 'succeeded', provider_reference = 'inventada', resolved_by_user_id = NULL,
         resolution = NULL, last_error = NULL WHERE id = opid;
  SET CONSTRAINTS "effect_operations_resolution_is_recorded" IMMEDIATE;
  PERFORM h.check('9E "lavar" a decisão sem fato do provedor: recusado', 'permitiu', 'WK003');
EXCEPTION WHEN SQLSTATE 'WK003' THEN
  PERFORM h.check('9E "lavar" a decisão sem fato do provedor: recusado',
    CASE WHEN SQLERRM LIKE '%recorded provider fact%' THEN 'WK003' ELSE SQLERRM END, 'WK003');
END;
SET CONSTRAINTS "effect_operations_resolution_is_recorded" DEFERRED;

opid2 := h.unknown_op('lead-63');
BEGIN   -- (c) um fato resolved que não corresponde a resolução nenhuma
  INSERT INTO effect_attempts (operation_id, event, actor, actor_user_id, from_status, to_status, applied, provider_reference, detail)
  VALUES (opid2, 'resolved', 'user', usr, 'unknown', 'succeeded', true, 'ref-x',
          '{"resolution":"confirmed_sent","evidence":{"source":"provider_api"},"justification":"a API mostrou entregue"}');
  PERFORM h.check('9E fato resolved sem a resolução na operação: recusado', 'permitiu', 'WK003');
EXCEPTION WHEN SQLSTATE 'WK003' THEN
  PERFORM h.check('9E fato resolved sem a resolução na operação: recusado', 'WK003', 'WK003');
END;

-- resfriamento no relógio do banco: preparado aqui, conferido abaixo
-- em outra transação, depois de o tempo passar de verdade.
CREATE TABLE IF NOT EXISTS h.cooling (op uuid);
DELETE FROM h.cooling; INSERT INTO h.cooling VALUES (h.unknown_op('lead-40'));

RAISE NOTICE '';
END $$;

SELECT pg_sleep(1.2);

DO $$
DECLARE opid uuid := (SELECT op FROM h.cooling);
BEGIN
PERFORM h.check('9B resfriamento (relógio do banco): 1,2 s depois, 30 s é cedo',
  h.eff_resolve(opid, 'confirmed_not_sent', NULL, 'provider_dashboard', 'nada para lead-40',
                'conferi no painel do provedor', 30), 'too_early');
PERFORM h.check('9B resfriamento (relógio do banco): 1,2 s depois, 1 s já passou',
  h.eff_resolve(opid, 'confirmed_not_sent', NULL, 'provider_dashboard', 'nada para lead-40',
                'conferi no painel do provedor', 1), 'resolved');
RAISE NOTICE '';
END $$;

-- =====================================================================
-- Seção 10 — RLS sem recursão (migration 0008)
--
-- As seções acima rodam como dono das tabelas, que não passa por RLS. Esta
-- roda como um papel COMUM (o equivalente ao `authenticated` do Supabase):
-- é o único jeito de exercitar as policies. Antes da 0008, qualquer leitura
-- aqui morria com "infinite recursion detected in policy for relation
-- workspace_members" — a policy de workspace_members lia workspace_members.
--
-- Precisa de permissão para criar papel (o `postgres` do Supabase tem). Sem
-- ela, a seção é PULADA com um aviso, em vez de dar falso PASS.
-- =====================================================================
SELECT h.seed();
DO $$
DECLARE usr uuid := (SELECT c.usr FROM h.ctx c); stranger uuid := gen_random_uuid();
        e uuid; ep int; visivel text; alheio text;
BEGIN
RAISE NOTICE '';
RAISE NOTICE '== 10. RLS sem recursão (0008) ==';

-- fixture: uma linha em cada tabela protegida
e := h.create_queued(); ep := h.claim(e);
PERFORM h.eff_attempt(e, 'send', 'lead-rls', 'mock.send_message', 'fp', ep, 'success');
PERFORM h.insert_nodes(e, ep, 'no');
PERFORM h.finish(e, 'success', ep);

PERFORM h.check('10.0 a função de pertinência é SECURITY DEFINER e STABLE',
  (SELECT p.prosecdef::text || '/' || (p.provolatile = 's')::text
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_workspace_member'), 'true/true');
PERFORM h.check('10.0 ...e search_path fixo (SECURITY DEFINER sem isso é sequestrável)',
  (SELECT (p.proconfig @> ARRAY['search_path=public, pg_temp'])::text
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_workspace_member'), 'true');
PERFORM h.check('10.0 toda policy de leitura passa por ela',
  (SELECT count(*) FILTER (WHERE qual LIKE '%is_workspace_member%') || '/' || count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN ('workspaces', 'workspace_members', 'workflows',
      'executions', 'execution_nodes', 'effect_operations', 'effect_attempts')), '7/7');
PERFORM h.check('10.0 e continua não existindo policy de escrita',
  (SELECT count(*)::text FROM pg_policies WHERE schemaname = 'public' AND cmd <> 'SELECT'), '0');

BEGIN
  CREATE ROLE h_rls_reader NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN insufficient_privilege THEN
    RAISE WARNING 'seção 10 PULADA: sem permissão para criar papel de teste';
    RETURN;
END;
GRANT USAGE ON SCHEMA public, auth TO h_rls_reader;
GRANT SELECT ON workspaces, workspace_members, workflows, executions, execution_nodes,
  effect_operations, effect_attempts TO h_rls_reader;

-- lendo como o membro
PERFORM set_config('request.jwt.claim.sub', usr::text, true);
PERFORM set_config('role', 'h_rls_reader', true);
SELECT (SELECT count(*) FROM workspaces) || '/' || (SELECT count(*) FROM workspace_members)
    || '/' || (SELECT count(*) FROM workflows) || '/' || (SELECT count(*) FROM executions)
    || '/' || (SELECT count(*) FROM execution_nodes) || '/' || (SELECT count(*) FROM effect_operations)
    || '/' || (SELECT count(*) FROM effect_attempts) INTO visivel;
-- e como alguém de fora
PERFORM set_config('role', 'none', true);
PERFORM set_config('request.jwt.claim.sub', stranger::text, true);
PERFORM set_config('role', 'h_rls_reader', true);
SELECT (SELECT count(*) FROM workspaces) || '/' || (SELECT count(*) FROM workspace_members)
    || '/' || (SELECT count(*) FROM workflows) || '/' || (SELECT count(*) FROM executions)
    || '/' || (SELECT count(*) FROM execution_nodes) || '/' || (SELECT count(*) FROM effect_operations)
    || '/' || (SELECT count(*) FROM effect_attempts) INTO alheio;
PERFORM set_config('role', 'none', true);
PERFORM set_config('request.jwt.claim.sub', '', true);

PERFORM h.check('10.1 membro lê (sem recursão): workspace/membros/workflow/execução/nós/operação/histórico',
  visivel, '1/1/1/1/1/1/3');
PERFORM h.check('10.2 quem não é membro não lê nada', alheio, '0/0/0/0/0/0/0');

REVOKE ALL ON workspaces, workspace_members, workflows, executions, execution_nodes,
  effect_operations, effect_attempts FROM h_rls_reader;
REVOKE ALL ON SCHEMA public, auth FROM h_rls_reader;
DROP ROLE h_rls_reader;

RAISE NOTICE '';
END $$;
