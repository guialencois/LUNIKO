// Fase 10.5B-1 — verificação executável: NADA fora de
// server/execution/effects/providers/mercadopago/ importa capabilities.ts.
//
//   node scripts/effects-spec/mercadopago/isolation.mjs            # árvore real
//   node scripts/effects-spec/mercadopago/isolation.mjs --mutate   # + controles
//
// --mutate NUNCA escreve na árvore do projeto: copia lib/ server/ app/
// components/ para um diretório temporário, planta ali cada import proibido
// (a verificação TEM de falhar), planta os falsos positivos (TEM de passar),
// apaga a cópia e roda de novo na árvore real (TEM de passar).
import { readdirSync, readFileSync, statSync, mkdtempSync, cpSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { scan, SCANNED_ROOTS, SCANNED_EXTENSIONS } from "./isolation-core.mjs";
import { SELF_TEST_CASES } from "./isolation-cases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

function collect(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next") continue;
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (SCANNED_EXTENSIONS.some((e) => name.endsWith(e))) {
        files.push({ path: relative(root, abs).split(sep).join("/"), source: readFileSync(abs, "utf8") });
      }
    }
  };
  for (const r of SCANNED_ROOTS) if (existsSync(join(root, r))) walk(join(root, r));
  return files;
}

function report(label, result) {
  const ok = result.violations.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${result.filesScanned} arquivos, ${result.capabilitiesImports} import(s) de capabilities, ${result.violations.length} violação(ões)`);
  for (const v of result.violations) console.log(`        ${v.path}: ${v.form} "${v.specifier}" — ${v.rule}`);
  return ok;
}

let failures = 0;
const real = scan(collect(ROOT));
if (!report("árvore real (lib/ server/ app/ components/)", real)) failures++;
if (real.capabilitiesImports === 0 && !existsSync(join(ROOT, "server/execution/effects/providers/mercadopago/capabilities.ts"))) {
  console.log("FAIL  capabilities.ts não existe — nada a isolar"); failures++;
}

if (process.argv.includes("--mutate")) {
  const tmp = mkdtempSync(join(tmpdir(), "mp-isolation-"));
  try {
    for (const r of SCANNED_ROOTS) if (existsSync(join(ROOT, r))) cpSync(join(ROOT, r), join(tmp, r), { recursive: true });
    const baseline = scan(collect(tmp));
    if (!report("cópia temporária, antes de mutar", baseline)) failures++;
    for (const c of SELF_TEST_CASES) {
      const abs = join(tmp, c.path);
      const existed = existsSync(abs);
      const before = existed ? readFileSync(abs, "utf8") : null;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, (before ?? "") + "\n" + c.source);
      const r = scan(collect(tmp));
      const detected = r.violations.length > 0;
      const ok = c.mustFail ? detected : !detected;
      console.log(`${ok ? (c.mustFail ? "MORTA " : "PASS  ") : (c.mustFail ? "VIVA  " : "FAIL  ")}  ${c.name}${ok ? "" : "  <-- verificação errou"}`);
      if (!ok) failures++;
      // restaura a cópia antes da próxima mutação
      if (existed) writeFileSync(abs, before); else rmSync(abs);
      const restored = scan(collect(tmp));
      if (restored.violations.length !== 0) { console.log(`FAIL  restauração após "${c.name}"`); failures++; }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const after = scan(collect(ROOT));
  if (!report("árvore real, depois das mutações", after)) failures++;
}

console.log(failures === 0 ? "\nisolamento: OK" : `\nisolamento: ${failures} falha(s)`);
process.exitCode = failures === 0 ? 0 : 1;
