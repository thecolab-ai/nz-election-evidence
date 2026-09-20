// Election family: the two value encodings shared by the export mapping (CLI) and the live adapters (Edge Function).

/** A publisher-stated date-time. A value without a zone is read as UTC on every machine, never in local time. */
export function publisherDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return undefined;
  const clean = value.trim();
  const zoned = /[zZ]$|[+-]\d\d:?\d\d$/.test(clean) ? clean : (clean.length === 10 ? clean + "T00:00:00" : clean.replace(" ", "T")) + "Z";
  const ms = Date.parse(zoned);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * A SHA-256 with its digits 0-9 written as the letters g-p (a-f unchanged). Written before the shared ledger guard
 * learned to set identifier tokens aside (20260921000100_import_shared.sql); the guard now accepts both spellings.
 * The encoding stays because it is part of every stored content hash of this family: changing it would make a new
 * version of every record. The projection decodes the one reference it joins on with translate().
 */
export function letterHex(hex: string): string {
  return hex.replace(/[0-9]/g, (digit) => String.fromCharCode(103 + Number(digit)));
}
