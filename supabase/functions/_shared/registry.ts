// Source registry: validation, deterministic config hashes and run manifests.

import { canonicalJson, sha256Hex } from "./canonical.ts";
import type { Json, ScheduleConfig, SourceConfig, SourcesFile } from "./types.ts";

const SOURCE_ID = /^[a-z][a-z0-9_]{2,62}$/;
const HOSTNAME = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** Never collected, whatever else is true: content that needs a sign-in or a payment. */
export const INELIGIBLE_ACCESS: ReadonlySet<string> = new Set(["authenticated", "paywalled"]);

export function validateSourcesFile(file: SourcesFile): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const source of file.sources) {
    const where = `source ${source.source_id}`;
    if (!SOURCE_ID.test(source.source_id)) problems.push(`${where}: bad source_id`);
    if (ids.has(source.source_id)) problems.push(`${where}: duplicate source_id`);
    ids.add(source.source_id);
    let official: URL | null = null;
    try {
      official = new URL(source.official_url);
    } catch {
      problems.push(`${where}: official_url is not a URL`);
    }
    if (official && official.protocol !== "https:") problems.push(`${where}: official_url must be https`);
    for (const host of source.allowed_hosts) {
      if (!HOSTNAME.test(host)) problems.push(`${where}: allowed host "${host}" is not a plain public hostname`);
      if (/(^|\.)(local|internal|lan|home|corp|localhost)$/.test(host) || /tailscale|\.ts\.net$/.test(host)) {
        problems.push(`${where}: allowed host "${host}" looks private`);
      }
    }
    if (source.adapter_kind === "live_fetch") {
      // A live source contacts a publisher, so the register must already hold a row for that publisher (a record of
      // the rights question, not an approval) and the config must say what kind of endpoint it is. Neither has a default.
      if (!source.rights_id || !/^RIGHTS-[0-9]{2,}$/.test(source.rights_id)) problems.push(`${where}: a live source needs a rights_id from the rights register`);
      if (!source.access_basis) problems.push(`${where}: a live source must state its access_basis`);
      if (source.access_basis && INELIGIBLE_ACCESS.has(source.access_basis) && (source.enabled || !source.blocked_reason)) {
        problems.push(`${where}: a source behind a sign-in or a paywall is never enabled and must carry its blocker`);
      }
      // No credential of any kind may ride along in a source's configuration: collection is anonymous.
      const credentialKey = Object.keys(source.adapter_options ?? {}).find((key) => /auth|token|secret|password|cookie|session|api[_-]?key|credential/i.test(key));
      if (credentialKey) problems.push(`${where}: adapter option "${credentialKey}" looks like a credential; only anonymous public requests are made`);
      if (/^https:\/\/[^/]*@/.test(source.official_url)) problems.push(`${where}: official_url carries credentials`);
      if (source.min_interval_ms !== undefined && (source.min_interval_ms < 1000 || source.min_interval_ms > 60000)) problems.push(`${where}: min_interval_ms must be 1000-60000`);
      if (source.allowed_hosts.length === 0) problems.push(`${where}: live sources need an allowlist`);
      if (official && !source.allowed_hosts.includes(official.hostname)) problems.push(`${where}: official_url host is not on the allowlist`);
    } else {
      if (source.allowed_hosts.length !== 0) problems.push(`${where}: export imports make no network requests`);
      if (!source.export_contract) problems.push(`${where}: export import needs an export_contract`);
      if (source.enabled) problems.push(`${where}: export imports are never schedule-enabled`);
    }
    if (source.adapter_name === "availability_probe" && source.enabled) problems.push(`${where}: a probe is never schedule-enabled`);
    if (!source.enabled && source.adapter_kind === "live_fetch" && !source.blocked_reason) {
      problems.push(`${where}: a disabled live source must say why`);
    }
    const contract = source.export_contract;
    if (contract) {
      if (!/^EVIDENCE_EXPORT_[A-Z0-9_]+$/.test(contract.fileEnv)) problems.push(`${where}: export file must be named by an EVIDENCE_EXPORT_* variable`);
      const assertsNomination = (contract.enumMaps ?? []).some((m) => Object.values(m.map).some((v) => v === "officially_nominated" || v === "elected" || v === "not_elected"));
      if (assertsNomination && !(contract.expectedInput && /^sha256:[0-9a-f]{64}$/.test(contract.expectedInput.sha256) && contract.expectedInput.rows > 0 && contract.manifestEnv)) {
        problems.push(`${where}: a contract that maps to officially_nominated must be pinned to one validated input (checksum, row count and manifest)`);
      }
      if (contract.manifestEnv && !/^EVIDENCE_EXPORT_[A-Z0-9_]+$/.test(contract.manifestEnv)) problems.push(`${where}: manifest must be named by an EVIDENCE_EXPORT_* variable`);
      const dropped = new Set(contract.droppedFields.map((d) => d.field));
      for (const rule of contract.allowedFields) {
        if (dropped.has(rule.from)) problems.push(`${where}: field ${rule.from} is both allowed and dropped`);
        if (/mail|phone|address|donor|body|html|raw|json|passage|path/i.test(rule.to)) problems.push(`${where}: field ${rule.to} is not importable`);
      }
    }
  }
  for (const schedule of file.schedules) {
    const source = file.sources.find((s) => s.source_id === schedule.source_id);
    const where = `schedule ${schedule.schedule_key}`;
    if (!source) problems.push(`${where}: unknown source`);
    else if (!source.enabled || source.adapter_kind !== "live_fetch") problems.push(`${where}: only enabled live sources can be scheduled`);
    if (schedule.cron_expr.trim().split(/\s+/).length !== 5) problems.push(`${where}: cron expression needs five fields`);
    if (schedule.max_runtime_seconds < 10 || schedule.max_runtime_seconds > 140) problems.push(`${where}: runtime outside the Edge Function budget`);
  }
  return problems;
}

export async function configHash(value: SourceConfig | ScheduleConfig): Promise<string> {
  return "sha256:" + (await sha256Hex(canonicalJson(value as unknown as Json)));
}

export interface RunManifest {
  manifest_version: 1;
  config_version: number;
  source_id: string;
  adapter_name: string;
  adapter_version: string;
  mode: "incremental" | "backfill" | "export_import";
  allowed_hosts: string[];
  snapshot_semantics: string;
  source_config_hash: string;
  max_records: number;
  /** For export imports: hash and size of the input file, never its location. */
  input_digest?: { sha256: string; bytes: number; rows: number };
}

/** The manifest holds no timestamps, so identical inputs always give an identical hash. */
export async function buildManifest(
  file: SourcesFile, source: SourceConfig, adapterVersion: string, mode: RunManifest["mode"], maxRecords: number,
  inputDigest?: RunManifest["input_digest"],
): Promise<{ manifest: RunManifest; manifestHash: string }> {
  const manifest: RunManifest = {
    manifest_version: 1,
    config_version: file.config_version,
    source_id: source.source_id,
    adapter_name: source.adapter_name,
    adapter_version: adapterVersion,
    mode,
    allowed_hosts: [...source.allowed_hosts].sort(),
    snapshot_semantics: source.snapshot_semantics,
    source_config_hash: await configHash(source),
    max_records: maxRecords,
    ...(inputDigest ? { input_digest: inputDigest } : {}),
  };
  return { manifest, manifestHash: "sha256:" + (await sha256Hex(canonicalJson(manifest as unknown as Json))) };
}

export async function registryPayload(file: SourcesFile, rightsRegister: { [key: string]: Json }[]): Promise<{ [key: string]: Json }> {
  const rights: Json[] = [];
  for (const row of rightsRegister) {
    rights.push({
      rights_id: row.rights_id, publisher: row.publisher, source_url: row.source_url,
      review_status: row.review_status, default_release: row.default_release,
      licence_or_terms_url: row.licence_or_terms_url ?? "", verified_permissions: row.verified_permissions ?? "",
      excluded_assets: row.excluded_assets ?? "", attribution: row.attribution ?? "", reviewed_on: row.reviewed_on ?? "",
      register_hash: "sha256:" + (await sha256Hex(canonicalJson(row))),
    });
  }
  const sources: Json[] = [];
  for (const source of file.sources) {
    sources.push({
      source_id: source.source_id, registry_key: source.registry_key ?? "", title: source.title, publisher: source.publisher,
      official_url: source.official_url, adapter_kind: source.adapter_kind, adapter_name: source.adapter_name,
      allowed_hosts: source.allowed_hosts, rights_id: source.rights_id ?? "", access_basis: source.access_basis ?? "", view_scope: source.view_scope,
      expected_cadence_seconds: source.expected_cadence_seconds ? String(source.expected_cadence_seconds) : "",
      snapshot_semantics: source.snapshot_semantics, enabled: source.enabled, blocked_reason: source.blocked_reason ?? "",
      catalogue_products: (source.catalogue_products ?? []) as unknown as Json, config_hash: await configHash(source),
    });
  }
  return { rights, registry_products: file.registry_products as unknown as Json, sources };
}

export async function schedulePayload(file: SourcesFile): Promise<Json[]> {
  const out: Json[] = [];
  for (const schedule of file.schedules) out.push({ ...schedule, config_hash: await configHash(schedule) });
  return out;
}
