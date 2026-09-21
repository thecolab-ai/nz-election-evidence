// Statistics family: the private artifact on disk.
//
// An artifact is a directory OUTSIDE the repository, named only through EVIDENCE_EXPORT_STATS_DIR:
//   <dir>/<source_id>/manifest.json            hashes, row counts, reconciliation, findings
//   <dir>/<source_id>/meta.jsonl               routes, datasets, releases, series, geographies, catalogue entries
//   <dir>/<source_id>/observations-00001.jsonl ... at most OBSERVATIONS_PER_FILE rows each
// Directories are 0700 and files 0600. Observation files are written as a stream, so a source with several hundred
// thousand rows never sits in memory. The reader re-hashes every file against the manifest before any row is used.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_VERSION, type ArtifactFile, type ArtifactManifest, type ArtifactRow, ContractError, type MetaRow, type ObservationRow,
  OBSERVATIONS_PER_FILE, validateRow,
} from "./contract.ts";

export const ARTIFACT_DIR_ENV = "EVIDENCE_EXPORT_STATS_DIR";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The artifact root must exist outside the repository: a private export is never one `git add` away from publication. */
export async function artifactRoot(env: { [key: string]: string | undefined }): Promise<string> {
  const named = env[ARTIFACT_DIR_ENV];
  if (!named) throw new ContractError(`set ${ARTIFACT_DIR_ENV} to a private directory outside the repository`);
  await mkdir(named, { recursive: true, mode: 0o700 });
  const real = await realpath(named);
  const repo = await realpath(REPO_ROOT);
  if (real === repo || real.startsWith(repo + sep) || repo.startsWith(real + sep)) {
    throw new ContractError(`${ARTIFACT_DIR_ENV} must not be inside (or contain) the repository`);
  }
  await chmod(real, 0o700);
  return real;
}

function line(row: unknown): string {
  return JSON.stringify(row) + "\n";
}

export class ArtifactWriter {
  private files: ArtifactFile[] = [];
  private stream: WriteStream | null = null;
  private hash = createHash("sha256");
  private bytes = 0;
  private rows = 0;
  private part = 0;
  observations = 0;
  byStatus: { [status: string]: number } = {};
  byDataset: { [dataset: string]: number } = {};
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async open(root: string, sourceId: string): Promise<ArtifactWriter> {
    const dir = join(root, sourceId);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return new ArtifactWriter(dir);
  }

  private async closePart(): Promise<void> {
    if (!this.stream) return;
    const stream = this.stream;
    await new Promise<void>((done, fail) => {
      stream.on("error", fail);
      stream.end(() => done());
    });
    const name = `observations-${String(this.part).padStart(5, "0")}.jsonl`;
    this.files.push({ name, sha256: this.hash.digest("hex"), bytes: this.bytes, rows: this.rows });
    this.stream = null;
  }

  async observation(row: ObservationRow): Promise<void> {
    validateRow(row);
    if (!this.stream || this.rows >= OBSERVATIONS_PER_FILE) {
      await this.closePart();
      this.part++;
      this.hash = createHash("sha256");
      this.bytes = 0;
      this.rows = 0;
      this.stream = createWriteStream(join(this.dir, `observations-${String(this.part).padStart(5, "0")}.jsonl`), { mode: 0o600 });
    }
    const text = line(row);
    this.hash.update(text);
    this.bytes += Buffer.byteLength(text);
    this.rows++;
    this.observations++;
    this.byStatus[row.value_status] = (this.byStatus[row.value_status] ?? 0) + 1;
    this.byDataset[row.dataset_key] = (this.byDataset[row.dataset_key] ?? 0) + 1;
    if (!this.stream.write(text)) await new Promise<void>((done) => this.stream!.once("drain", () => done()));
  }

  async finish(meta: MetaRow[], manifest: Omit<ArtifactManifest, "artifact_version" | "files" | "counts">): Promise<ArtifactManifest> {
    await this.closePart();
    for (const row of meta) validateRow(row);
    const text = meta.map(line).join("");
    await writeFile(join(this.dir, "meta.jsonl"), text, { mode: 0o600 });
    const count = (kind: string) => meta.filter((row) => row.kind === kind).length;
    const full: ArtifactManifest = {
      artifact_version: ARTIFACT_VERSION, ...manifest,
      files: [{ name: "meta.jsonl", sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text), rows: meta.length }, ...this.files],
      counts: {
        routes: count("route"), datasets: count("dataset"), releases: count("release"), series: count("series"), geographies: count("geography"),
        observations: this.observations, catalogue_entries: count("catalogue_entry"),
        observations_by_status: Object.fromEntries(Object.entries(this.byStatus).sort()), observations_by_dataset: Object.fromEntries(Object.entries(this.byDataset).sort()),
      },
    };
    await writeFile(join(this.dir, "manifest.json"), JSON.stringify(full, null, 2) + "\n", { mode: 0o600 });
    return full;
  }
}

export interface OpenArtifact {
  dir: string;
  manifest: ArtifactManifest;
  /** SHA-256 over the manifest's file list: the identity of this exact artifact in the run ledger. */
  digest: string;
  meta: MetaRow[];
  observationFiles: ArtifactFile[];
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).byteLength;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** Reads and verifies an artifact. Any file that does not match its manifest entry refuses the whole artifact. */
export async function openArtifact(root: string, sourceId: string): Promise<OpenArtifact> {
  const dir = join(root, sourceId);
  let manifest: ArtifactManifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf-8")) as ArtifactManifest;
  } catch {
    throw new ContractError(`no readable artifact manifest for ${sourceId}; run the exporter first`);
  }
  if (manifest.artifact_version !== ARTIFACT_VERSION) throw new ContractError("artifact was written by a different contract version");
  if (manifest.source_id !== sourceId) throw new ContractError("artifact manifest names a different source");
  for (const file of manifest.files) {
    if (!/^(meta|observations-\d{5})\.jsonl$/.test(file.name)) throw new ContractError("artifact manifest lists an unexpected file name");
    const actual = await hashFile(join(dir, file.name));
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new ContractError(`artifact file ${file.name} does not match its manifest entry`);
  }
  const meta: MetaRow[] = [];
  for await (const row of readRows(join(dir, "meta.jsonl"))) {
    if (row.kind === "observation") throw new ContractError("meta file holds an observation");
    meta.push(row);
  }
  if (meta.length !== manifest.files[0].rows) throw new ContractError("meta row count differs from the manifest");
  const digest = "sha256:" + createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex");
  return { dir, manifest, digest, meta, observationFiles: manifest.files.filter((f) => f.name.startsWith("observations-")) };
}

export async function* readRows(path: string): AsyncGenerator<ArtifactRow> {
  const lines = createInterface({ input: createReadStream(path, "utf-8"), crlfDelay: Infinity });
  let number = 0;
  for await (const text of lines) {
    number++;
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ContractError(`artifact line ${number} is not JSON`);
    }
    yield validateRow(parsed);
  }
}

export async function* readObservations(artifact: OpenArtifact, file: ArtifactFile): AsyncGenerator<ObservationRow> {
  let rows = 0;
  for await (const row of readRows(join(artifact.dir, file.name))) {
    if (row.kind !== "observation") throw new ContractError("observation file holds another kind of row");
    rows++;
    yield row;
  }
  if (rows !== file.rows) throw new ContractError(`${file.name} row count differs from the manifest`);
}
