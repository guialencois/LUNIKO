import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  // Os componentes usam o runtime automático de JSX — nenhum deles importa
  // React. O padrão do esbuild é emitir React.createElement, e aí todo teste
  // .tsx morre com "React is not defined" no render(). Isto alinha o
  // transformador do vitest com o que o Next já faz no build.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // Os testes de integração falam com um Postgres REMOTO (Supabase), e cada
    // consulta custa uma ida e volta pela internet — ~200ms contra menos de um
    // milissegundo num banco local, que é para o que estes testes foram
    // escritos. Um teste com dezenas de consultas estoura os 5s padrão sem ter
    // defeito algum: numa execução, 49 das 57 falhas eram só isso.
    //
    // O limite só sobe quando existe TEST_DATABASE_URL. Sem ela rodam apenas os
    // unitários, e aí o padrão curto continua valendo — um teste unitário que
    // leva 5 segundos é defeito de verdade e deve falhar.
    //
    // E precisam rodar um ARQUIVO POR VEZ. O vitest paraleliza arquivos, e
    // todos compartilham o mesmo banco: o reaper de um arquivo varre TODAS as
    // execuções existentes, e o worker de outro consome a fila alheia. Com
    // isso um teste espera 'queued' e encontra 'error' porque outro suite
    // recuperou a execução dele. Não é defeito do produto — é a suíte, escrita
    // supondo um banco exclusivo, rodando contra um banco compartilhado.
    ...(process.env.TEST_DATABASE_URL
      ? { testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false }
      : {}),
    // lib/env.ts valida o ambiente no carregamento do módulo, então qualquer
    // teste que importe uma rota falha sem estas variáveis. O vitest não lê
    // .env.local — isso é comportamento do Next, não do vitest.
    //
    // Todos os valores são FALSOS e existem só para satisfazer o formato
    // (URL válida, tamanho mínimo). Nenhuma credencial real entra aqui.
    // Os testes de integração sobrescrevem DATABASE_URL com TEST_DATABASE_URL
    // no próprio beforeAll, e continuam se autopulando sem ela.
    env: {
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "valor-falso-de-teste",
      SUPABASE_SERVICE_ROLE_KEY: "valor-falso-de-teste",
      DATABASE_URL: "postgres://usuario:senha@localhost:5432/banco_de_teste",
      ENCRYPTION_KEY: "chave-falsa-de-teste-com-mais-de-32-caracteres",
    },
  },
});
