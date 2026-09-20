// Shared privacy and source-access controls. One copy of each rule, used by every family through the loader contract.
//
//   Private inputs   live outside the repository, in a directory and files nobody else on the machine can read.
//   Source access    only endpoints served to the anonymous public are ever contacted; a blocked route is reported as
//                    blocked and never retried around. Eligibility to collect says nothing about rights to publish.
//   Outputs          receipts carry counts, digests, statuses and publisher links. Never a location on a disk, a
//                    connection string, a credential or a payload.

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INELIGIBLE_ACCESS } from "../../../supabase/functions/_shared/registry.ts";
import { textViolation } from "../../../supabase/functions/_shared/text_guard.ts";
import type { SourceConfig } from "../../../supabase/functions/_shared/types.ts";
import { LoaderError } from "./contract.ts";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function insideRepository(location: string, root: string = REPOSITORY_ROOT): boolean {
  const rel = relative(root, resolve(location));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Inside ANY git checkout (this worktree, the main checkout, another worktree): a `.git` entry in an ancestor. */
export function insideAnyCheckout(location: string): boolean {
  let dir = resolve(location);
  for (;;) {
    if (existsSync(resolve(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export interface PrivateInputFinding { input: string; finding: string }

/**
 * A private input must sit outside the repository (always refused otherwise: it could be committed), and must not be
 * readable by group or others. `label` names the input in messages; the location itself is never echoed.
 * `ownerOnly: "advise"` exists for one older capture that predates the 0600 rule: the finding is recorded in the
 * receipt instead of refusing the input. Family artifacts are always "require".
 */
export async function assertPrivateInput(location: string, label: string, ownerOnly: "require" | "advise" = "require", root: string = REPOSITORY_ROOT): Promise<PrivateInputFinding[]> {
  if (insideRepository(location, root) || insideAnyCheckout(location)) throw new LoaderError("input_location_not_private", `${label}: the private input sits inside the repository; move it outside before anything reads it`);
  const findings: PrivateInputFinding[] = [];
  let info;
  try {
    info = await stat(location);
  } catch {
    throw new LoaderError("input_missing", `${label}: the private input named by the environment does not exist`);
  }
  const holder = info.isDirectory() ? info : await stat(dirname(location));
  for (const [what, mode] of [["the input", info.mode], ["its directory", holder.mode]] as const) {
    if ((mode & 0o077) !== 0) {
      const message = `${what} is readable by group or others (expected 0600 files in a 0700 directory)`;
      if (ownerOnly === "require") throw new LoaderError("input_location_not_private", `${label}: ${message}`);
      findings.push({ input: label, finding: message });
    }
  }
  return findings;
}

export interface RouteAccess { allowed: boolean; code: "route_blocked" | "route_pending_decision" | null; reason: string | null }

/**
 * May the refresh route of this live source be run now? Decided from closed values, never from the wording of a note:
 *   - a sign-in or a paywall: never (the runner refuses too; this answers before anything is built);
 *   - a probe: it records availability, it is not a refresh route;
 *   - a disabled source: only when the registry says it is disabled because it is CLI-only. A publisher block, a pending
 *     decision, or a disabled source that does not say why, is never contacted.
 */
export function refreshAccess(source: SourceConfig): RouteAccess {
  if (source.adapter_kind !== "live_fetch") return { allowed: false, code: "route_blocked", reason: "not a live source" };
  if (!source.access_basis || INELIGIBLE_ACCESS.has(source.access_basis)) return { allowed: false, code: "route_blocked", reason: "only public unauthenticated endpoints are contacted" };
  if (source.adapter_name === "availability_probe") return { allowed: false, code: "route_blocked", reason: source.blocked_reason ?? "availability probe only: the publisher does not serve this host" };
  if (source.enabled || source.disabled_because === "cli_only") return { allowed: true, code: null, reason: null };
  if (source.disabled_because === "pending_person_decision") return { allowed: false, code: "route_pending_decision", reason: source.blocked_reason ?? null };
  return { allowed: false, code: "route_blocked", reason: source.blocked_reason ?? "disabled without a stated reason" };
}

const CONNECTION = /postgres(?:ql)?:\/\/\S+/g;
const HOME_LOCATION = /(^|["\s=:(,])(\/(home|Users|root|var|mnt|srv|tmp|opt|data)\/[^\s"']*)/g;

/** Text that may leave the process: connection strings and disk locations are cut out, length is bounded. */
export function sanitize(message: string): string {
  return message.replace(CONNECTION, "postgres://[redacted]").replace(HOME_LOCATION, "$1[location withheld]").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted]").slice(0, 600);
}

/**
 * A receipt is written AFTER the work is committed, so a value that may not leave the process must not cost the
 * receipt: the offending string is replaced by a marker that names the rule it broke, and the rest is kept.
 */
export function redactReceipt<T>(value: T): { value: T; redacted: number } {
  let redacted = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const violation = textViolation(node);
      if (!violation) return node;
      redacted++;
      return `[withheld from this receipt: ${violation}]`;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]));
    return node;
  };
  return { value: walk(value) as T, redacted };
}

/** Every string in a receipt is checked with the shared ledger guard before it is printed or written. */
export function receiptViolations(value: unknown, path = "receipt"): string[] {
  const problems: string[] = [];
  const walk = (node: unknown, at: string) => {
    if (typeof node === "string") {
      const violation = textViolation(node);
      if (violation) problems.push(`${at}: ${violation}`);
    } else if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${at}[${i}]`));
    else if (node && typeof node === "object") for (const [key, item] of Object.entries(node)) walk(item, `${at}.${key}`);
  };
  walk(value, path);
  return problems;
}
