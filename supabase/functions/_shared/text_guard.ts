// The ONE TypeScript mirror of evidence_private.text_violation (supabase/migrations/20260921000100_import_shared.sql).
// Preflights use it so a row the store would refuse stops the whole input before any write. The store remains the
// authority: this mirror exists to fail early, never to allow something the store would not.
//
// Kept equal to the SQL function by test: ingest/test/fixtures/text_guard_vectors.json is run through this module
// offline and through the database function in the integration suite.

export type TextViolation =
  | "control_characters"
  | "email_like_value"
  | "filesystem_location_value"
  | "credential_like_value"
  | "phone_like_value";

// The store cannot hold a NUL at all, so the mirror refuses it here rather than letting the insert fail.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const FILESYSTEM = /(^|["\s=:(,])(file:\/\/|~\/|[A-Za-z]:\\|\/(home|Users|root|var|mnt|srv|etc|tmp|opt|data)\/)/;
// \s: the database treats a no-break space as whitespace too (checked against the real function; shared vectors hold both to it).
const CREDENTIAL_ASSIGNMENT = /(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token|bearer|authorization)["']?\s*[=:]\s*\S/i;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;
// Assembled from pieces so this file does not itself look like it holds a token.
const KNOWN_TOKEN = new RegExp("(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github" + "_pat_|sb_secret_|sk-[A-Za-z0-9]{16,}|BEGIN [A-Z ]*PRIVATE KEY)");
const URL_CREDENTIALS = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

/** Identifier tokens, removed before the phone test and only for it: whole-token UUIDs, and whole tokens of 16 to 128 hex characters. */
const UUID = /(^|[^0-9A-Za-z])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Za-z])/g;
const HEX_TOKEN = /(^|[^0-9A-Za-z])[0-9a-fA-F]{16,128}(?![0-9A-Za-z])/g;
const PHONE = /(^|[^0-9])(\+?64|0)[ -]?[2-9][0-9]?[ -]?[0-9]{3}[ -]?[0-9]{3,4}([^0-9]|$)/;
const PHONE_WORD = /(ph|phone|mob|tel|call)/i;

export function withoutIdentifierTokens(text: string): string {
  return text.replace(UUID, "$1 ").replace(HEX_TOKEN, "$1 ");
}

export function textViolation(text: string | null | undefined): TextViolation | null {
  if (text === null || text === undefined || text === "") return null;
  if (CONTROL.test(text)) return "control_characters";
  if (EMAIL.test(text)) return "email_like_value";
  if (FILESYSTEM.test(text)) return "filesystem_location_value";
  if (CREDENTIAL_ASSIGNMENT.test(text) || JWT.test(text) || KNOWN_TOKEN.test(text) || URL_CREDENTIALS.test(text)) return "credential_like_value";
  if (PHONE.test(withoutIdentifierTokens(text)) && PHONE_WORD.test(text)) return "phone_like_value";
  return null;
}
