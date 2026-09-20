// SCRAM-SHA-256 verifier, computed on the operator's machine so that a role password never travels to the
// server inside a statement. Postgres stores exactly this string in pg_authid and accepts it in
// ALTER ROLE ... PASSWORD '<verifier>'. What a statement log or audit log can then capture is a salted,
// iterated hash - not the password.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

export const SCRAM_ITERATIONS = 4096;

/** Printable ASCII without spaces or quotes: identical under SASLprep, safe in any shell, env file or URL-encoder. */
export function secretShapeProblem(value: string, minLength: number): string | null {
  if (value.length < minLength) return `must be at least ${minLength} characters`;
  if (value.length > 256) return "must be at most 256 characters";
  if (!/^[\x21-\x7e]+$/.test(value)) return "must be printable ASCII with no spaces";
  if (/['"\\]/.test(value)) return "must not contain quotes or backslashes";
  if (new Set(value).size < 10) return "has too little variety to be a generated secret";
  return null;
}

export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16), iterations = SCRAM_ITERATIONS): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

export const VERIFIER_SHAPE = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;
