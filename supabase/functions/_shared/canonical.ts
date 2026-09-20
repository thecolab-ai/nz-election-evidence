// Deterministic JSON and content hashing. The hash covers the allowlisted projection only,
// so a refresh that changes nothing but the retrieval time yields the same hash.

import type { Json } from "./types.ts";

export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("non-finite number cannot be hashed");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const item = value[key];
    if (item === undefined) continue;
    parts.push(JSON.stringify(key) + ":" + canonicalJson(item));
  }
  return "{" + parts.join(",") + "}";
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function contentHash(recordKind: string, projectionVersion: number, payload: { [key: string]: Json }): Promise<string> {
  return "sha256:" + (await sha256Hex(canonicalJson({ kind: recordKind, projection: projectionVersion, payload })));
}

/** Collapse whitespace and decode the handful of HTML entities that appear in publisher listings. */
export function cleanText(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;|&rsquo;|&#8217;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
