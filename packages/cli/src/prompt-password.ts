/**
 * Masked stdin input prompt -- zero-dependency raw-mode read, no echo.
 * Used by `twing login`'s interactive-paste path when no `--token` is
 * given; every other command either has a stored PAT or doesn't need one.
 * Not password-specific despite the name (kept for now to avoid touching
 * every call site) -- it's a generic masked line reader, used today for
 * pasting a personal access token rather than typing a password.
 *
 * Control characters are built via String.fromCharCode rather than typed
 * literally, so the source stays plain ASCII and unambiguous to read.
 */

const ENTER_CHARS = new Set(["\n", "\r"]);
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE_CHARS = new Set([String.fromCharCode(127), String.fromCharCode(8)]);

export function promptPassword(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("stdin isn't a TTY to prompt on -- pass the value as a flag instead, or run this interactively once"));
      return;
    }

    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.setRawMode(true);

    let password = "";
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      for (const char of s) {
        if (ENTER_CHARS.has(char) || char === CTRL_D) {
          cleanup();
          process.stdout.write("\n");
          resolve(password);
          return;
        }
        if (char === CTRL_C) {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (BACKSPACE_CHARS.has(char)) {
          password = password.slice(0, -1);
          continue;
        }
        password += char;
      }
    };

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    }

    process.stdin.on("data", onData);
  });
}
