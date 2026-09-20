// Secret input for operator tools. A secret is NEVER a command-line argument (visible in the process list and in
// shell history) and is never echoed or printed. Two ways in:
//   - an interactive terminal: a hidden prompt, typed or pasted twice;
//   - a pipe on standard input (from a password manager): the first line.
import { createInterface } from "node:readline";

export interface SecretIo {
  isTTY: boolean;
  /** Reads one line with echo off (TTY only). */
  readHidden(prompt: string): Promise<string>;
  /** Reads the first line of piped standard input (non-TTY only). */
  readPiped(): Promise<string>;
}

export const processIo: SecretIo = {
  get isTTY() { return Boolean(process.stdin.isTTY); },
  readHidden(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const stdin = process.stdin;
      process.stderr.write(prompt);
      stdin.setRawMode(true);
      stdin.resume();
      let value = "";
      const finish = (error?: Error) => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
        process.stderr.write("\n");
        if (error) reject(error); else resolve(value);
      };
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\r" || ch === "\n") return finish();
          if (ch === "\u0003" || ch === "\u0004") return finish(new Error("cancelled"));
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else value += ch;
        }
      };
      stdin.on("data", onData);
    });
  },
  readPiped(): Promise<string> {
    return new Promise((resolve) => {
      const lines = createInterface({ input: process.stdin, terminal: false });
      let first: string | null = null;
      lines.on("line", (line) => { first ??= line; });
      lines.on("close", () => resolve(first ?? ""));
    });
  },
};

/** A deliberate refusal. Its message never contains a secret, so it is safe to show. */
export class RefusedError extends Error {}

/** Any argument that tries to carry a secret is refused before anything else happens. */
export function refuseSecretArguments(argv: string[]): void {
  for (const arg of argv) {
    if (/^--?(password|passwd|pass|secret|cron[-_]?secret|token|key|login[-_]?password)\b/i.test(arg)) {
      throw new RefusedError("secrets are never accepted on the command line; run without it and use the hidden prompt or pipe the value on standard input");
    }
    if (/^postgres(ql)?:\/\/[^/]*:[^/]*@/i.test(arg)) {
      throw new RefusedError("a connection string with a password is never accepted on the command line; use the PG* environment variables");
    }
  }
}

export async function readSecret(label: string, io: SecretIo = processIo): Promise<string> {
  if (!io.isTTY) return (await io.readPiped()).replace(/\r$/, "");
  const first = await io.readHidden(`${label} (input hidden): `);
  const second = await io.readHidden(`${label} again: `);
  if (first !== second) throw new RefusedError("the two entries did not match; nothing was changed");
  return first;
}
