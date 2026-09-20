#!/usr/bin/env node
// Rebuilds the committed registry from the core sources and the three family fragments.
//
//   node src/loaders/registry_build.ts            check: exit 1 when the committed file is out of date or the merge has a problem
//   node src/loaders/registry_build.ts --write    rewrite supabase/functions/_shared/sources.config.json

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SourcesFile } from "../../../supabase/functions/_shared/types.ts";
import { REPOSITORY_ROOT } from "./access.ts";
import { mergeRegistry, rightsProblems, type RightsRow } from "./registry.ts";

const CONFIG = resolve(REPOSITORY_ROOT, "supabase/functions/_shared/sources.config.json");

export async function buildRegistry(): Promise<{ text: string; committed: string; problems: string[] }> {
  const committed = await readFile(CONFIG, "utf-8");
  const { file, problems } = mergeRegistry(JSON.parse(committed) as SourcesFile);
  const register = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "catalogue/rights-register.json"), "utf-8")) as RightsRow[];
  return { text: JSON.stringify(file, null, 2) + "\n", committed, problems: [...problems, ...rightsProblems(file, register)] };
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const { text, committed, problems } = await buildRegistry();
  for (const problem of problems) console.error("- " + problem);
  if (problems.length) process.exit(1);
  if (process.argv.includes("--write")) {
    await writeFile(CONFIG, text);
    console.log("registry written: " + (JSON.parse(text) as SourcesFile).sources.length + " sources");
  } else if (text !== committed) {
    console.error("the committed registry is out of date: run `node src/loaders/registry_build.ts --write`");
    process.exit(1);
  } else console.log("registry is up to date: " + (JSON.parse(text) as SourcesFile).sources.length + " sources");
}
