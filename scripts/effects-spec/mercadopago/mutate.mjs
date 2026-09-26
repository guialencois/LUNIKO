// Roda cada mutação de mutations.mjs sobre uma CÓPIA do build (WORK/out ->
// WORK/mut) e a spec contra a cópia. "Morta" = a spec não passou (FAIL, ou
// abortou). "Viva" = a spec passou com o contrato errado: a mutação NÃO foi
// detectada. Chamado por run.sh --mutate.
import { readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MUTATIONS, CONTRACT_FILE, applyMutation } from "./mutations.mjs";

const WORK = process.env.WORK;
if (!WORK) { console.error("rode via run.sh --mutate"); process.exit(2); }
const spec = readFileSync(join(WORK, "spec.mjs"), "utf8").replaceAll("./out/", "./mut/");
writeFileSync(join(WORK, "spec-mut.mjs"), spec);

let dead = 0, alive = 0, errors = 0;
for (const m of MUTATIONS) {
  rmSync(join(WORK, "mut"), { recursive: true, force: true });
  cpSync(join(WORK, "out"), join(WORK, "mut"), { recursive: true });
  const file = join(WORK, "mut", CONTRACT_FILE);
  const mutated = applyMutation(readFileSync(file, "utf8"), m);
  if (mutated === null) { console.log(`ERRO    ${m.name} (trecho não encontrado)`); errors++; continue; }
  writeFileSync(file, mutated);
  const r = spawnSync(process.execPath, ["spec-mut.mjs"], { cwd: WORK, encoding: "utf8", timeout: 60_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const nfail = (out.match(/^FAIL /gm) ?? []).length;
  if (r.status === 0) { console.log(`VIVA    ${m.name}  <-- a spec NÃO detectou`); alive++; }
  else if (nfail > 0) { console.log(`MORTA   ${m.name}  (asserção: ${nfail} FAIL)`); dead++; }
  else { console.log(`MORTA   ${m.name}  (abortou: ${(out.match(/^\w*Error: .{0,70}/m) ?? ["?"])[0]})`); dead++; }
}
console.log(`\nmutações: ${dead}/${MUTATIONS.length} mortas, ${alive} vivas, ${errors} com erro de aplicação`);
process.exitCode = alive === 0 && errors === 0 ? 0 : 1;
