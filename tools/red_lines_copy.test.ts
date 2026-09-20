// The TS/TSX copy scanner: it must catch red-line wording wherever a reader could see it, and must not trip on code.
// Every sample below is a TEST FIXTURE string, never published.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { breachesIn, extractCopy, isScanned, R1_ADVOCACY_SOURCE, R4_DISHONESTY_SOURCE, scanRepository } from "./red_lines_copy.ts";

const root = new URL("..", import.meta.url).pathname;
const rules = (file: string, source: string) => breachesIn(file, source).map((b) => `${b.rule}:${b.kind}:${b.line}`);

test("regression: red-line wording is caught in JSX text, attributes, string constants and templates", () => {
  assert.deepEqual(rules("a.tsx", "export function A() {\n  return <p>The minister lied to the House.</p>\n}"), ["R4:jsx_text:2"]);
  assert.deepEqual(rules("a.tsx", "export const A = () => (\n  <section>\n    <h2>Results</h2>\n    <p>\n      Vote for the people who\n      kept their word.\n    </p>\n  </section>\n)"), ["R1:jsx_text:5", "R1:jsx_text:3"],
    "reported at the sentence's own line, and again for the enclosing element whose text contains it");
  assert.deepEqual(rules("a.tsx", "const x = <img alt=\"A fraudulent return\" className=\"w-4\" />"), ["R4:jsx_attribute:1"]);
  assert.deepEqual(rules("a.tsx", "const x = <Note title={'This was a cover-up'}>ok</Note>"), ["R4:string:1"]);
  assert.deepEqual(rules("a.ts", "export const BANNER = 'Do not vote for them'\n"), ["R1:string:1"]);
  assert.deepEqual(rules("a.ts", "export const label = (n: string) => `${n} is a liar`\n"), ["R4:template:1"]);
  assert.deepEqual(rules("a.ts", "const LABELS = { broken: 'Promise broken - dishonest', kept: 'kept' }"), ["R4:string:1"]);
  assert.deepEqual(rules("a.tsx", "const x = cond ? <b>re-elect</b> : null"), ["R1:jsx_text:1"]);
  assert.deepEqual(rules("index.html", "<html>\n<title>Who lied?</title>\n</html>"), ["R4:jsx_text:2"]);
});

test("regression: a phrase split across an inline element or a line break is still one sentence", () => {
  assert.deepEqual(rules("a.tsx", "const x = <p>Please <strong>vote</strong> for the incumbent</p>").length > 0, true);
  assert.deepEqual(rules("a.tsx", "const x = (\n  <p>\n    do not\n    vote\n  </p>\n)"), ["R1:jsx_text:3"]);
});

test("regression: JSX given as an attribute value or inside braces does not knock the scanner out of JSX mode", () => {
  // Found in review: after a sibling closing tag, `fallback={<X rows={5} />}` was read as code and its `/` as a regular
  // expression, so the text that followed was silently skipped.
  const source = "const x = (\n  <>\n    <div>ok</div>\n    <Suspense fallback={<LoadingBlock label=\"Loading\" rows={5} />}>\n      <p>He lied to the House</p>\n    </Suspense>\n  </>\n)";
  assert.ok(rules("a.tsx", source).includes("R4:jsx_text:5"));
  assert.ok(rules("a.tsx", "const x = <ul><li>a</li>{<li>vote for them</li>}</ul>").some((r) => r.startsWith("R1:jsx_text")));
  assert.ok(rules("a.tsx", "const x = <ul>{items.map((i) => <li key={i}>a liar</li>)}</ul>").some((r) => r.startsWith("R4:jsx_text")));
  assert.ok(rules("a.tsx", "const x = <p>{ok && <b>fraud</b>}</p>\nconst y = <p>later: re-elect</p>").length >= 2, "and the rest of the file is still scanned");
  assert.ok(rules("a.tsx", "const n = total / count / 2\nconst y = <p>cover-up</p>").some((r) => r.startsWith("R4")), "a division does not start a regular expression");
});

test("no false positives on source code: identifiers, comments, regular expressions, imports and non-rendering attributes", () => {
  const code = [
    "import { lies } from './lies'",
    "import fraud from \"../fraud/corrupt\"",
    "export { liar } from './liar'",
    "// the liar paradox: this comment says lied, fraud and vote for",
    "/* a cover-up in a block comment\n   re-elect, dishonest */",
    "const lies = 3, liar = lies + 1, fraud = liar < lies",
    "function corrupt(lie: number) { return lie / 2 / lies }",
    "const BLOCKED = /\\b(lied|lies|liar|fraud|vote for|re-?elect)\\b/i",
    "const ok = text.replace(/cover[- ]?up/g, '')",
    "const relies = 'this relies on the applied, belief and earliest values'",
    "const x = <div className=\"lie-flat fraud-banner\" data-testid=\"liar\" id=\"corrupt\" key=\"lies\">fine</div>",
    "const y = <Link to=\"/lies\" href=\"https://example.org/fraud\">source</Link>",
    "const z = a < lies && lies > b ? useMemo<Fraud>(() => lies, []) : null",
    "const t = cond ? createColumnHelper<CoreFeatures, Liar>() : undefined",
  ].join("\n");
  assert.deepEqual(breachesIn("a.tsx", code), []);
  assert.deepEqual(breachesIn("a.ts", code.split("\n").slice(0, 10).join("\n")), []);
});

test("the extractor sees what a reader sees, with line numbers, and nothing else", () => {
  const texts = extractCopy("const a = 'one'\n// 'not me'\nconst b = <p title=\"two\" className=\"no\">three {`four ${a} five`} six</p>\nconst c = /'seven'/\n", true);
  assert.deepEqual(texts.map((t) => [t.kind, t.line, t.text]), [
    ["string", 1, "one"], ["jsx_attribute", 3, "two"], ["template", 3, "four five"], ["jsx_text", 3, "three six"],
  ]);
});

test("the real explorer is scanned - the footer's and the banner's actual sentences are among the extracted text - and is clean", () => {
  const footer = extractCopy(readFileSync(root + "web/src/components/footer.tsx", "utf-8"), true).map((t) => t.text).join(" | ");
  assert.match(footer, /This is an independent project\. It is not affiliated with/);
  assert.match(footer, /Accountable person:/);
  const shell = extractCopy(readFileSync(root + "web/src/components/shell.tsx", "utf-8"), true).map((t) => t.text).join(" | ");
  assert.match(shell, /Nothing here is a finding, a ranking or a recommendation\./);
  const result = scanRepository(root);
  assert.ok(result.files >= 50 && result.texts >= 1500, `scanned ${result.files} files, ${result.texts} texts`);
  assert.deepEqual(result.breaches, []);
});

test("tests and generated types are the only exemptions", () => {
  assert.equal(isScanned("web/src/components/footer.tsx"), true);
  assert.equal(isScanned("web/src/lib/format.ts"), true);
  assert.equal(isScanned("web/src/lib/lib.test.ts"), false);
  assert.equal(isScanned("web/src/components/components.test.tsx"), false);
  assert.equal(isScanned("web/src/lib/database.types.ts"), false);
});

test("the two patterns are the ones scripts/red_lines.py enforces on documents", () => {
  const python = readFileSync(root + "scripts/red_lines.py", "utf-8");
  const pattern = (name: string) => {
    const block = new RegExp(name + " = re\\.compile\\(([\\s\\S]*?)\\n\\)").exec(python)?.[1] ?? "";
    return [...block.matchAll(/r"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("").replace(/^\(\?i\)/, "");
  };
  assert.equal(pattern("R4_DISHONESTY"), R4_DISHONESTY_SOURCE);
  assert.equal(pattern("R1_ADVOCACY"), R1_ADVOCACY_SOURCE);
});
