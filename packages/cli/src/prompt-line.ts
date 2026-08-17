/**
 * Plain (echoed, line-edited) stdin prompt -- `node:readline`, not
 * `prompt-password.ts`'s masked raw-mode reader, since what this asks for
 * (a server URL) isn't a secret and should behave like a normal terminal
 * line (backspace, etc.) rather than being hidden. Same TTY guard as
 * `promptPassword`, for the same reason: never hang a non-interactive run
 * (CI, a script) waiting on input that will never come.
 */

import * as readline from "node:readline/promises";

export async function promptLine(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("stdin isn't a TTY to prompt on -- pass the value as a flag instead, or run this interactively once");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
