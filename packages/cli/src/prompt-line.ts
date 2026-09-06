/**
 * Plain (echoed, line-edited) stdin prompt -- `node:readline`, not
 * `prompt-password.ts`'s masked raw-mode reader, since what this asks for
 * (a server URL) isn't a secret and should behave like a normal terminal
 * line (backspace, etc.) rather than being hidden. Same TTY guard as
 * `promptPassword`, for the same reason: never hang a non-interactive run
 * (CI, a script) waiting on input that will never come.
 */

import * as readline from "node:readline/promises";

/** A bare Enter (an empty trimmed line) falls back to `defaultValue` when
 * given. Pure and exported separately so it's unit-testable without faking
 * a TTY -- `promptLine` itself reads directly from `process.stdin`/
 * `process.stdout` with no injectable seam, same as `prompt-password.ts`. */
export function applyDefault(answer: string, defaultValue?: string): string {
  return answer === "" && defaultValue !== undefined ? defaultValue : answer;
}

/** `defaultValue`, when given, is returned as-is for a bare Enter -- the
 * caller's `question` text is responsible for showing it, this function
 * doesn't append anything to it itself. */
export async function promptLine(question: string, defaultValue?: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("stdin isn't a TTY to prompt on -- pass the value as a flag instead, or run this interactively once");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return applyDefault((await rl.question(question)).trim(), defaultValue);
  } finally {
    rl.close();
  }
}
