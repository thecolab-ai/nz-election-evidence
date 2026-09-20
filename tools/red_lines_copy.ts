#!/usr/bin/env node
// Red lines R1 and R4 for user-facing copy that lives in TypeScript and TSX.
//
//   node tools/red_lines_copy.ts            scan web/src and web/index.html; exit 1 on any breach
//
// scripts/red_lines.py scans documents and data files. The explorer's wording, though, is written inside source
// files, where a line-by-line text scan would either miss it or trip over code. This tool reads the source the
// way a compiler front end does and tests ONLY text a reader could be shown:
//
//   scanned      string literals, the text parts of template literals, JSX text, JSX string attributes
//   not scanned  comments, identifiers and other code, regular-expression literals, import/export specifiers,
//                attributes that never render as words (className, data-testid, key, href, to, ...)
//
// So `const lies = ...`, `// the liar paradox` or `/\b(lied|lies)\b/` do not fail the build, and
// <p>He lied</p>, title="a cover-up" or `vote for ${name}` do. The two patterns are the ones in
// scripts/red_lines.py, and a test holds them equal. (The TypeScript compiler API is not used: the pinned
// typescript package ships no JavaScript API, so the front end here is a small purpose-built scanner.)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const R4_DISHONESTY_SOURCE =
  "\\b(lied|lie|lies|lying|liar|dishonest(?:y|ly)?|corrupt(?:ion|ly)?|fraud(?:ulent)?|" +
  "deceived|deceit(?:ful)?|deliberately misl(?:ed|eading)|cover[- ]?up)\\b";
export const R1_ADVOCACY_SOURCE =
  "\\b(vote (?:for|against)|do(?:n'?t| not) vote|party vote for|back (?:the )?(?:party|govt|government)|" +
  "support (?:the )?(?:party|government)|oppose (?:the )?(?:party|government)|kick (?:them|him|her) out|" +
  "get rid of (?:the )?(?:party|government|minister)|re-?elect)\\b";
const R4 = new RegExp(R4_DISHONESTY_SOURCE, "i");
const R1 = new RegExp(R1_ADVOCACY_SOURCE, "i");

export interface CopyText { text: string; line: number; kind: "string" | "template" | "jsx_text" | "jsx_attribute" }
export interface Breach { file: string; line: number; rule: "R1" | "R4"; kind: CopyText["kind"]; match: string }

/** Attributes whose values are never shown to a reader as words. */
const NON_COPY_ATTRIBUTES = new Set(["classname", "class", "data-testid", "testid", "key", "id", "href", "to", "src", "rel", "target", "type", "htmlfor",
  "name", "role", "viewbox", "d", "fill", "stroke", "xmlns", "method", "autocomplete", "inputmode", "pattern", "lang", "dir", "charset", "http-equiv"]);

const JSX_MAY_FOLLOW = new Set(["(", ",", "=", ":", "?", "[", "{", "}", ";", "&", "|", "!", ">"]);
const JSX_MAY_FOLLOW_WORD = new Set(["return", "default", "yield", "else"]);
const REGEX_MAY_FOLLOW = new Set(["(", ",", "=", ":", "?", "[", "{", "}", ";", "&", "|", "!", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_MAY_FOLLOW_WORD = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do"]);

/** Every piece of reader-facing text in one TypeScript or TSX source. */
export function extractCopy(source: string, tsx: boolean): CopyText[] {
  const out: CopyText[] = [];
  let i = 0;
  let line = 1;
  let lastChar = "";   // last significant (non-space, non-comment) character of code
  let lastWord = "";   // the identifier or keyword that character ended, if any
  let moduleSpecifierNext = false;

  const advance = (n = 1) => { for (let k = 0; k < n && i < source.length; k++) { if (source[i] === "\n") line++; i++; } };
  const significant = (ch: string, word = "") => { lastChar = ch; lastWord = word; };

  /**
   * An expression container: `{` in JSX, `${` in a template. What follows is the START of an expression, so a `<` there
   * opens an element and a `/` opens a regular expression, whatever token happened to precede the container.
   */
  function enterExpression(): void {
    significant("{");
    readCode(true);
  }

  function readQuoted(quote: string): { text: string; line: number } {
    const startLine = line;
    advance();
    let text = "";
    while (i < source.length && source[i] !== quote) {
      if (source[i] === "\\") { text += unescape(source[i + 1] ?? ""); advance(2); continue; }
      if (source[i] === "\n" && quote !== "`") break;
      text += source[i];
      advance();
    }
    advance();
    return { text, line: startLine };
  }
  const unescape = (ch: string) => (ch === "n" || ch === "r" || ch === "t" ? " " : ch);

  function readTemplate(): void {
    const startLine = line;
    advance();
    let text = "";
    while (i < source.length && source[i] !== "`") {
      if (source[i] === "\\") { text += unescape(source[i + 1] ?? ""); advance(2); continue; }
      if (source[i] === "$" && source[i + 1] === "{") {
        advance(2);
        enterExpression();
        text += " ";  // a substituted value stands where a word would, so the sentence around it stays whole
        continue;
      }
      text += source[i];
      advance();
    }
    if (text.trim()) out.push({ text: text.replace(/\s+/g, " ").trim(), line: startLine, kind: "template" });
    advance();
    significant("`");
  }

  function readRegex(): void {
    advance();
    let inClass = false;
    while (i < source.length && source[i] !== "\n") {
      if (source[i] === "\\") { advance(2); continue; }
      if (source[i] === "[") inClass = true;
      else if (source[i] === "]") inClass = false;
      else if (source[i] === "/" && !inClass) break;
      advance();
    }
    advance();
    while (i < source.length && /[a-z]/i.test(source[i])) advance();
    significant(")");
  }

  /** Returns the element's own text, so the sentence it sits in can be tested whole. */
  function readJsxElement(): string {
    advance(); // <
    if (source[i] === ">") { advance(); return readJsxChildren(); }
    while (i < source.length && /[\w.:-]/.test(source[i])) advance();
    for (;;) {
      while (i < source.length && /\s/.test(source[i])) advance();
      if (i >= source.length) return "";
      if (source[i] === "/" && source[i + 1] === ">") { advance(2); return ""; }
      if (source[i] === ">") { advance(); return readJsxChildren(); }
      if (source[i] === "{") { advance(); enterExpression(); continue; }
      let name = "";
      while (i < source.length && /[\w:-]/.test(source[i])) { name += source[i]; advance(); }
      if (!name) { advance(); continue; }
      while (i < source.length && /\s/.test(source[i])) advance();
      if (source[i] !== "=") continue;
      advance();
      while (i < source.length && /\s/.test(source[i])) advance();
      if (source[i] === '"' || source[i] === "'") {
        const value = readQuoted(source[i]);
        if (!NON_COPY_ATTRIBUTES.has(name.toLowerCase()) && value.text.trim()) out.push({ text: value.text, line: value.line, kind: "jsx_attribute" });
      } else if (source[i] === "{") {
        advance();
        const before = out.length;
        enterExpression();
        if (NON_COPY_ATTRIBUTES.has(name.toLowerCase())) out.splice(before);
      }
    }
  }

  function readJsxChildren(): string {
    let text = "";
    let startLine = line;
    const finish = () => {
      const whole = text.replace(/\s+/g, " ").trim();
      if (whole) out.push({ text: whole, line: startLine, kind: "jsx_text" });
      return whole;
    };
    while (i < source.length) {
      if (source[i] === "{") { advance(); enterExpression(); text += " "; continue; }
      if (source[i] === "<") {
        if (source[i + 1] === "/") { while (i < source.length && source[i] !== ">") advance(); advance(); significant(")"); return finish(); }
        // An inline element (<strong>, <a>) sits inside a sentence. Its words are tested on their own line AND as part
        // of the sentence around them, so a phrase split across the element is still seen.
        text += " " + readJsxElement() + " ";
        continue;
      }
      if (!text.trim()) startLine = line;
      text += source[i];
      advance();
    }
    return finish();
  }

  function readCode(untilBrace: boolean): void {
    let depth = 0;
    while (i < source.length) {
      const ch = source[i];
      if (ch === "/" && source[i + 1] === "/") { while (i < source.length && source[i] !== "\n") advance(); continue; }
      if (ch === "/" && source[i + 1] === "*") { advance(2); while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) advance(); advance(2); continue; }
      if (/\s/.test(ch)) { advance(); continue; }
      if (ch === '"' || ch === "'") {
        const value = readQuoted(ch);
        if (!moduleSpecifierNext && value.text.trim()) out.push({ text: value.text, line: value.line, kind: "string" });
        moduleSpecifierNext = false;
        significant(")");
        continue;
      }
      if (ch === "`") { readTemplate(); continue; }
      if (ch === "/" && (lastChar === "" || REGEX_MAY_FOLLOW.has(lastChar) || REGEX_MAY_FOLLOW_WORD.has(lastWord))) { readRegex(); continue; }
      if (tsx && ch === "<" && /[A-Za-z>]/.test(source[i + 1] ?? "") && (lastChar === "" || JSX_MAY_FOLLOW_WORD.has(lastWord) || (lastWord === "" && JSX_MAY_FOLLOW.has(lastChar)))) {
        readJsxElement();
        significant(")");
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let word = "";
        while (i < source.length && /[\w$]/.test(source[i])) { word += source[i]; advance(); }
        if (word === "from" || word === "import" || word === "require") moduleSpecifierNext = true;
        else if (word !== "type") moduleSpecifierNext = moduleSpecifierNext && word === "from";
        significant(word[word.length - 1], word);
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}") { if (untilBrace && depth === 0) { advance(); significant("}"); return; } depth--; }
      if (ch === ";" ) moduleSpecifierNext = false;
      if (ch === "(" && lastWord !== "import" && lastWord !== "require") moduleSpecifierNext = false;
      significant(ch);
      advance();
    }
  }

  readCode(false);
  return out;
}

export function breachesIn(file: string, source: string): Breach[] {
  const texts: CopyText[] = /\.html?$/.test(file)
    ? source.split("\n").map((text, index) => ({ text: text.replace(/<[^>]*>/g, " "), line: index + 1, kind: "jsx_text" as const }))
    : extractCopy(source, /\.tsx$/.test(file));
  const breaches: Breach[] = [];
  for (const t of texts) {
    const r4 = R4.exec(t.text);
    if (r4) breaches.push({ file, line: t.line, rule: "R4", kind: t.kind, match: r4[0] });
    const r1 = R1.exec(t.text);
    if (r1) breaches.push({ file, line: t.line, rule: "R1", kind: t.kind, match: r1[0] });
  }
  const seen = new Set<string>();
  return breaches.filter((b) => { const k = `${b.rule}:${b.line}:${b.match.toLowerCase()}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Tests assert the words on purpose, and generated types hold no copy. Everything else under web/src is scanned. */
export function isScanned(path: string): boolean {
  return /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path) && !/(^|\/)database\.types\.ts$/.test(path) && !/\.d\.ts$/.test(path);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? (entry === "node_modules" ? [] : walk(full)) : [full];
  });
}

export function scanRepository(root: string): { files: number; texts: number; breaches: Breach[] } {
  const files = [...walk(join(root, "web/src")).filter((f) => isScanned(f)), join(root, "web/index.html")];
  const breaches: Breach[] = [];
  let texts = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    if (!/\.html$/.test(file)) texts += extractCopy(source, file.endsWith(".tsx")).length;
    breaches.push(...breachesIn(relative(root, file), source));
  }
  return { files: files.length, texts, breaches };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = scanRepository(root);
  if (result.breaches.length) {
    console.error("RED LINE BREACH in explorer copy");
    for (const b of result.breaches) console.error(`- ${b.rule} wording in ${b.file}:${b.line} (${b.kind})`);
    process.exit(1);
  }
  console.log(`OK: no red-line wording in explorer copy (${result.files} files, ${result.texts} pieces of reader-facing text)`);
}
