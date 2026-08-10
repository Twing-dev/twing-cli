import * as readline from "node:readline/promises";
import type { Driver, DriverContext } from "./driver.js";

/**
 * Both sessions can run with a human driver at once (they run concurrently
 * by design), but there's only one terminal -- without serializing access,
 * two prompts could interleave mid-question. This shared queue makes sure
 * only one `question()` is in flight at a time, whichever session gets
 * there first; the other simply waits its turn.
 */
class StdinQueue {
  private tail: Promise<void> = Promise.resolve();
  private rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  async ask(prompt: string): Promise<string> {
    const run = this.tail.then(() => this.rl.question(prompt));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  close(): void {
    this.rl.close();
  }
}

const sharedQueue = new StdinQueue();

export class HumanDriver implements Driver {
  async nextMessage(ctx: DriverContext): Promise<string | null> {
    console.log(`\n[${ctx.sessionLabel}] turn ${ctx.turnNumber}/${ctx.maxTurns} -- agent said:\n${ctx.latestAgentResult}\n`);

    if (ctx.turnNumber >= ctx.maxTurns) {
      console.log(`[${ctx.sessionLabel}] reached max turns (${ctx.maxTurns}), stopping.`);
      return null;
    }

    const answer = await sharedQueue.ask(`[${ctx.sessionLabel}] your reply (blank to stop this session): `);
    return answer.trim() === "" ? null : answer;
  }
}

export function closeHumanInput(): void {
  sharedQueue.close();
}
