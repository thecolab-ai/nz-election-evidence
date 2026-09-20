// Shared privacy and source-access controls. One copy of each rule, used by every family through the loader contract.
//
//   Private inputs   live outside the repository, in a directory and files nobody else on the machine can read.
//   Source access    only endpoints served to the anonymous public are ever contacted; a blocked route is reported as
//                    blocked and never retried around. Eligibility to collect says nothing about rights to publish.
//   Outputs          receipts carry counts, digests, statuses and publisher links. Never a location on a disk, a
//                    connection string, a credential or a payload.

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

export interface PrivateInputFinding { input: string; finding: string }

/**
 * A private input must sit outside the repository (always refused otherwise: it could be committed), and must not be
 * readable by group or others. `label` names the input in messages; the location itself is never echoed.
 * `ownerOnly: "advise"` exists for one older capture that predates the 0600 rule: the finding is recorded in the
 * receipt instead of refusing the input. Family artifacts are always "require".
 */
export async function assertPrivateInput(location: string, label: string, ownerOnly: "require" | "advise" = "require", root: string = REPOSITORY_ROOT): Promise<PrivateInputFinding[]> {
  if (insideRepository(location, root)) throw new LoaderError("input_location_not_private", `${label}: the private input sits inside the repository; move it outside before anything reads it`);
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

const PENDING_DECISION = /waits on a person|pending a person|person's decision/i;

/**
 * May the refresh route of this live source be run now? Deliberately conservative:
 *   - a sign-in or a paywall: never (the runner refuses too; this answers before anything is built);
 *   - a probe: it records availability, it is not a refresh route;
 *   - a source the registry marks disabled because a publisher challenged it, or because a person's decision is pending.
 * A disabled source whose note says it runs "from the CLI only" is a working CLI route and is allowed.
 */
export function refreshAccess(source: SourceConfig): RouteAccess {
  if (source.adapter_kind !== "live_fetch") return { allowed: false, code: "route_blocked", reason: "not a live source" };
  if (!source.access_basis || INELIGIBLE_ACCESS.has(source.access_basis)) return { allowed: false, code: "route_blocked", reason: "only public unauthenticated endpoints are contacted" };
  if (source.adapter_name === "availability_probe") return { allowed: false, code: "route_blocked", reason: source.blocked_reason ?? "availability probe only: the publisher does not serve this host" };
  if (!source.enabled && source.blocked_reason) {
    if (PENDING_DECISION.test(source.blocked_reason)) return { allowed: false, code: "route_pending_decision", reason: source.blocked_reason };
    if (/CLI only|from the CLI|family CLI|Run deliberately/i.test(source.blocked_reason)) return { allowed: true, code: null, reason: null };
    return { allowed: false, code: "route_blocked", reason: source.blocked_reason };
  }
  return { allowed: true, code: null, reason: null };
}

const CONNECTION = /postgres(?:ql)?:\/\/\S+/g;
const HOME_LOCATION = /(^|["\s=:(,])(\/(home|Users|root|var|mnt|srv|tmp|opt|data)\/[^\s"']*)/g;

/** Text that may leave the process: connection strings and disk locations are cut out, length is bounded. */
export function sanitize(message: string): string {
  return message.replace(CONNECTION, "postgres://[redacted]").replace(HOME_LOCATION, "$1[location withheld]").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted]").slice(0, 600);
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
