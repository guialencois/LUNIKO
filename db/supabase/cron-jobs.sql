-- =====================================================================
-- Agendamento do consumidor da fila — Supabase Cron (pg_cron + pg_net)
--
-- NÃO FAZ PARTE DA CADEIA DE MIGRATIONS, DE PROPÓSITO.
-- `scripts/migrate.ts` aplica todo .sql de db/migrations/ em qualquer
-- Postgres — inclusive o banco local de teste e o harness. `pg_cron` e
-- `pg_net` só existem no Supabase, então colocar isto lá dentro quebraria
-- desenvolvimento local e a validação. Este arquivo é rodado UMA VEZ, à
-- mão, no SQL Editor do projeto Supabase.
--
-- POR QUE SUPABASE CRON E NÃO VERCEL CRON
-- No plano Hobby o Vercel Cron roda uma vez por dia, com precisão de ±59
-- min — inutilizável como consumidor de fila. O Supabase Cron agenda a
-- partir de 1 segundo e já faz parte da infraestrutura deste projeto.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------
-- 1. Segredos
--
-- NÃO cole a URL e o CRON_SECRET direto nos comandos de agendamento: o
-- comando fica legível em cron.job para qualquer um que consiga ler essa
-- tabela. Guarde no Vault e leia de lá na hora da chamada.
--
-- CRON_SECRET tem de ser o MESMO valor da variável de ambiente do deploy
-- na Vercel — é o que `lib/auth/scheduler.ts` compara. Gere com:
--     openssl rand -hex 32
-- ---------------------------------------------------------------------

-- select vault.create_secret('https://SEU-APP.vercel.app', 'automation_app_url');
-- select vault.create_secret('SEU_CRON_SECRET_AQUI',       'automation_cron_secret');

-- Helper: monta os headers a partir do Vault, para os dois jobs abaixo.
create or replace function public.automation_scheduler_headers()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (
      select decrypted_secret from vault.decrypted_secrets
      where name = 'automation_cron_secret'
    )
  );
$$;

create or replace function public.automation_app_url()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets
  where name = 'automation_app_url';
$$;

-- ---------------------------------------------------------------------
-- 2. Worker — consome a fila
--
-- Cada invocação é limitada (ver server/execution/run-worker-invocation.ts):
-- ela pega no máximo 10 jobs, tem orçamento interno de 240s abaixo do
-- maxDuration de 300s da rota, e termina por conta própria. Quando a fila
-- está vazia ela volta em milissegundos, então um intervalo curto é barato.
--
-- Invocações sobrepostas são seguras por construção: o claim usa
-- FOR UPDATE SKIP LOCKED e toda escrita final é protegida pela época do
-- claim (fencing). Não há coordenação entre invocações, e não precisa
-- haver.
--
-- 30s é um ponto de partida: é a latência máxima entre enfileirar e
-- começar a executar. Ajuste pelo caso de uso — segundos para resposta a
-- lead, minutos para relatório de campanha.
-- ---------------------------------------------------------------------
select cron.schedule(
  'automation-worker',
  '30 seconds',
  $$
    select net.http_post(
      url     := public.automation_app_url() || '/api/internal/worker',
      headers := public.automation_scheduler_headers(),
      body    := '{}'::jsonb,
      timeout_milliseconds := 290000
    );
  $$
);

-- ---------------------------------------------------------------------
-- 3. Reaper — devolve execuções travadas para a fila
--
-- REAPER_STALE_MS = 90s (MAX_EXECUTION_TIME_MS de 30s + 60s de margem).
-- O intervalo do cron decide só a latência de detecção, nunca a correção:
-- uma execução de worker morto é recuperada entre 90s e 90s + um intervalo
-- depois de travar. 30s mantém essa cauda curta sem varrer à toa.
--
-- A varredura é idempotente e segura de sobrepor: dois sweeps simultâneos
-- não conseguem recuperar a mesma linha duas vezes.
--
-- O endpoint NÃO aceita staleMs/maxAttempts — ver o comentário na rota
-- sobre por que esses parâmetros não podem cruzar a rede.
-- ---------------------------------------------------------------------
select cron.schedule(
  'automation-reaper',
  '30 seconds',
  $$
    select net.http_post(
      url     := public.automation_app_url() || '/api/internal/reaper',
      headers := public.automation_scheduler_headers(),
      body    := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $$
);

-- ---------------------------------------------------------------------
-- 4. Operação
-- ---------------------------------------------------------------------

-- Ver o que está agendado:
--   select jobid, jobname, schedule, active from cron.job order by jobname;

-- Ver as últimas execuções do agendamento (isto é o histórico do CRON,
-- não das execuções de workflow — essas ficam na tabela `executions`):
--   select jobid, status, return_message, start_time, end_time
--   from cron.job_run_details order by start_time desc limit 20;

-- As respostas HTTP do pg_net chegam de forma assíncrona:
--   select id, status_code, content, created
--   from net._http_response order by created desc limit 20;

-- Pausar / remover:
--   select cron.unschedule('automation-worker');
--   select cron.unschedule('automation-reaper');

-- ---------------------------------------------------------------------
-- 5. Limitações conhecidas deste agendamento
--
-- - O Supabase Cron roda no máximo 8 jobs concorrentes e cada job deve
--   durar no máximo 10 minutos. Os dois jobs acima cabem com folga.
-- - `pg_net` dispara a requisição e não espera a resposta: o cron só sabe
--   que a chamada partiu, não se o worker concluiu. O estado real de cada
--   execução está em `executions`, que é a fonte de verdade — não em
--   `cron.job_run_details`.
-- - Se a URL ou o segredo estiverem errados, o endpoint responde 401/503 e
--   a fila simplesmente não é consumida, em silêncio. Vale conferir
--   `net._http_response` depois de agendar pela primeira vez.
-- ---------------------------------------------------------------------
