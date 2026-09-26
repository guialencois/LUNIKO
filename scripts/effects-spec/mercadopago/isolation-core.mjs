// Fase 10.5B-1 — núcleo PURO da verificação de isolamento de capabilities.ts.
// Sem fs, sem node: recebe { path, source }[] e devolve as violações — por
// isso roda igual em node (isolation.mjs) e em qualquer outro runtime JS.
//
// O que conta como import: o ESPECIFICADOR de
//   import ... from "x" · import "x" · import type ... from "x"
//   export * from "x" · export { ... } from "x" · export type { ... } from "x"
//   import("x") · require("x")  (inclusive `import x = require("x")`)
// com o especificador em string ou template sem interpolação. Palavras em
// comentário, em string, em template ou em regex NÃO contam: o texto é
// tokenizado antes, e só um token de código `import`/`export`/`require`
// seguido da forma acima é lido.
//
// Limite conhecido (heurística do lexer): texto JSX com aspas (ex.: <p>Don't</p>)
// é lido como início de string; por isso aspas simples/duplas terminam na quebra
// de linha, e o estrago fica confinado àquela linha.

export const ADAPTER_DIR = "server/execution/effects/providers/mercadopago";
export const CAPABILITIES_MODULE = `${ADAPTER_DIR}/capabilities`;
export const SCANNED_ROOTS = ["lib", "server", "app", "components"];
export const SCANNED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

const REGEX_PRECEDERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "=>"]);
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "in", "of", "new", "delete", "void", "throw", "else", "do", "await", "yield"]);

/** Tokens: ident | str (value = conteúdo) | tpl (sem ${}) | tplx (com ${}) | punct | regex | num. */
export function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  const prevSignificant = () => out[out.length - 1];
  const isIdStart = (c) => /[A-Za-z_$]/.test(c);
  const isId = (c) => /[A-Za-z0-9_$]/.test(c);
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1, val = "";
      while (j < n && src[j] !== c && src[j] !== "\n") { if (src[j] === "\\") { val += src[j + 1] ?? ""; j += 2; continue; } val += src[j++]; }
      out.push({ t: "str", v: val });
      i = j + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1, val = "", interp = false, depth = 0;
      while (j < n) {
        const d = src[j];
        if (depth === 0 && d === "`") break;
        if (d === "\\") { val += src[j + 1] ?? ""; j += 2; continue; }
        if (depth === 0 && d === "$" && src[j + 1] === "{") { interp = true; depth = 1; j += 2; continue; }
        if (depth > 0) { if (d === "{") depth++; else if (d === "}") depth--; j++; continue; }
        val += d; j++;
      }
      out.push({ t: interp ? "tplx" : "tpl", v: val });
      i = j + 1;
      continue;
    }
    if (c === "/") {
      const p = prevSignificant();
      const regexOk = !p || (p.t === "punct" && REGEX_PRECEDERS.has(p.v)) || (p.t === "ident" && REGEX_KEYWORDS.has(p.v));
      if (regexOk) {
        let j = i + 1, inClass = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === "[") inClass = true;
          else if (src[j] === "]") inClass = false;
          else if (src[j] === "/" && !inClass) break;
          j++;
        }
        j++;
        while (j < n && isId(src[j])) j++;
        out.push({ t: "regex", v: src.slice(i, j) });
        i = j;
        continue;
      }
    }
    if (isIdStart(c)) { let j = i; while (j < n && isId(src[j])) j++; out.push({ t: "ident", v: src.slice(i, j) }); i = j; continue; }
    if (/[0-9]/.test(c)) { let j = i; while (j < n && /[0-9A-Za-z_.]/.test(src[j])) j++; out.push({ t: "num", v: src.slice(i, j) }); i = j; continue; }
    if (c === "=" && src[i + 1] === ">") { out.push({ t: "punct", v: "=>" }); i += 2; continue; }
    out.push({ t: "punct", v: c });
    i++;
  }
  return out;
}

const isSpec = (tok) => tok && (tok.t === "str" || tok.t === "tpl");

/** Especificadores de módulo REAIS de um arquivo, com a forma de cada um. */
export function findModuleSpecifiers(src) {
  const toks = tokenize(src);
  const found = [];
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t !== "ident") continue;
    const prev = toks[k - 1];
    if (prev && prev.t === "punct" && prev.v === ".") continue; // obj.import / obj.require
    const next = toks[k + 1];
    if (tk.v === "require" && next?.v === "(" && isSpec(toks[k + 2]) && toks[k + 3]?.v === ")") {
      found.push({ form: "require", specifier: toks[k + 2].v });
      continue;
    }
    if (tk.v === "import") {
      if (next?.v === "(" && isSpec(toks[k + 2])) { found.push({ form: "dynamic-import", specifier: toks[k + 2].v }); continue; }
      if (isSpec(next)) { found.push({ form: "import", specifier: next.v }); continue; }
      if (next?.t === "punct" && next.v === ".") continue; // import.meta
      // import [type] X, { a as b }, * as ns from "x" — até `from` + string, parando em `;`
      for (let j = k + 1; j < Math.min(toks.length, k + 400); j++) {
        const t = toks[j];
        if (t.t === "punct" && t.v === ";") break;
        if (t.t === "ident" && t.v === "require") break; // import x = require("x") é pego acima
        if (t.t === "ident" && t.v === "from" && isSpec(toks[j + 1])) { found.push({ form: "import", specifier: toks[j + 1].v }); break; }
        if (t.t === "ident" && (t.v === "import" || t.v === "export") && j > k + 1) break;
      }
      continue;
    }
    if (tk.v === "export") {
      const n1 = next;
      const startsReexport = n1 && ((n1.t === "punct" && (n1.v === "*" || n1.v === "{")) || (n1.t === "ident" && n1.v === "type" && toks[k + 2]?.t === "punct" && (toks[k + 2].v === "{" || toks[k + 2].v === "*")));
      if (!startsReexport) continue;
      for (let j = k + 1; j < Math.min(toks.length, k + 400); j++) {
        const t = toks[j];
        if (t.t === "punct" && t.v === ";") break;
        if (t.t === "punct" && t.v === "}" && !(toks[j + 1]?.t === "ident" && toks[j + 1].v === "from")) break;
        if (t.t === "ident" && t.v === "from" && isSpec(toks[j + 1])) { found.push({ form: "reexport", specifier: toks[j + 1].v }); break; }
      }
    }
  }
  return found;
}

function normalize(p) {
  const parts = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop(); else parts.push(seg);
  }
  return parts.join("/");
}

/** Especificador -> caminho do projeto (sem extensão), ou null se for pacote externo. */
export function resolveSpecifier(importerPath, specifier) {
  let target;
  if (specifier.startsWith("@/")) target = specifier.slice(2);
  else if (specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..") {
    const dir = importerPath.split("/").slice(0, -1).join("/");
    target = `${dir}/${specifier}`;
  } else return null;
  let t = normalize(target);
  t = t.replace(/\.(?:d\.)?(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/, "");
  t = t.replace(/\/index$/, "");
  return t;
}

const inAdapter = (p) => p === ADAPTER_DIR || p.startsWith(`${ADAPTER_DIR}/`);

/**
 * Regra absoluta: nenhum arquivo FORA do adaptador importa capabilities.ts, de
 * nenhuma forma. E, para que a regra não seja contornada por um atalho, nenhum
 * arquivo DENTRO do adaptador a re-exporta.
 */
export function scan(files) {
  const violations = [];
  let imports = 0;
  for (const { path, source } of files) {
    for (const { form, specifier } of findModuleSpecifiers(source)) {
      if (resolveSpecifier(path, specifier) !== CAPABILITIES_MODULE) continue;
      imports++;
      if (!inAdapter(path)) violations.push({ path, form, specifier, rule: "import de capabilities fora do adaptador" });
      else if (form === "reexport") violations.push({ path, form, specifier, rule: "re-export de capabilities (atalho para fora)" });
    }
  }
  return { violations, capabilitiesImports: imports, filesScanned: files.length };
}
