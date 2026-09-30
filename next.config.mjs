/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Server Actions and route handlers must never leak service-role secrets
  // to the client. Only NEXT_PUBLIC_* vars are exposed to the browser bundle.
  eslint: {
    // Sem esta lista, o `next lint` olha apenas app/, pages/, components/,
    // lib/ e src/ — que é o padrão do Next 14. server/ e scripts/ ficavam de
    // fora, e é em server/ que mora quase toda a lógica de execução e de
    // efeitos, incluindo o adaptador do Mercado Pago.
    //
    // O efeito prático era este: `@typescript-eslint/no-explicit-any` está
    // ligada como "error" no .eslintrc.json, mas não guardava esses arquivos.
    // Um `any` em server/ passava batido — o `tsc` aceita `any`, e o lint nem
    // olhava.
    //
    // De `scripts/` isto cobre o migrate.ts, que é código de verdade. O
    // harness `scripts/effects-spec/` fica de fora, por `ignorePatterns` no
    // .eslintrc.json: o tsconfig.json já o exclui (linha "exclude"), e lá o
    // `any` é a ferramenta correta, não desleixo — em
    // `V extends Table<infer R, any, any> ? R : never` o `any` é o que faz o
    // tipo condicional casar com qualquer instanciação. Com `unknown` o
    // modelo de tipos para de funcionar.
    dirs: ["app", "components", "lib", "server", "scripts"],
  },
};

export default nextConfig;
