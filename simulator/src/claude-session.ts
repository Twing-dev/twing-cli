/**
 * Drives a real `claude` CLI session headlessly: `-p`/`--print` with
 * `--output-format json` for a single-shot result, `--resume <session_id>`
 * to continue the same conversation on subsequent turns. Verified against
 * the real CLI (2.1.226) -- the JSON shape here is empirical, not assumed:
 * `{ type: "result", session_id, result, is_error, total_cost_usd,
 * num_turns, ... }`, and `--resume` reuses the same session_id rather than
 * minting a new one each turn.
 *
 * `--permission-mode bypassPermissions` is required for headless operation
 * -- there's no TTY here to answer a permission prompt, so anything less
 * than full bypass risks the process hanging forever on the first Bash
 * call or similar. This is a sandboxed simulator working on a throwaway
 * fixture copy, never twing-cli's own source -- an intentional, scoped
 * tradeoff, not a general recommendation.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

export interface ClaudeTurnResult {
  sessionId: string;
  resultText: string;
  isError: boolean;
  costUsd: number;
  numTurns: number;
}

interface ClaudeResultJson {
  type: string;
  subtype?: string;
  session_id: string;
  result?: string;
  is_error: boolean;
  total_cost_usd: number;
  num_turns: number;
}

export interface ClaudeSessionOptions {
  cwd: string;
  model: string;
}

export class ClaudeSession {
  private sessionId: string | null = null;

  constructor(private readonly options: ClaudeSessionOptions) {}

  async send(prompt: string): Promise<ClaudeTurnResult> {
    const args = ["-p", prompt, "--output-format", "json", "--permission-mode", "bypassPermissions", "--model", this.options.model];
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    const { stdout } = await execFileAsync("claude", args, { cwd: this.options.cwd, maxBuffer: MAX_BUFFER });

    let parsed: ClaudeResultJson;
    try {
      parsed = JSON.parse(stdout) as ClaudeResultJson;
    } catch (err) {
      throw new Error(`claude -p returned non-JSON output: ${stdout.slice(0, 500)}`, { cause: err });
    }

    this.sessionId = parsed.session_id;
    return {
      sessionId: parsed.session_id,
      resultText: parsed.result ?? "",
      isError: parsed.is_error,
      costUsd: parsed.total_cost_usd,
      numTurns: parsed.num_turns,
    };
  }
}
