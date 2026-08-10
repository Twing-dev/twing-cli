export interface DriverContext {
  sessionLabel: "A" | "B";
  goal: string;
  /** The turn that was just completed (1 = the agent's first response). */
  turnNumber: number;
  maxTurns: number;
  latestAgentResult: string;
}

export interface Driver {
  /** Called after each agent turn. Return null to end the session (goal
   * looks done, or there's nothing more to add); otherwise the string to
   * send as the next message. */
  nextMessage(context: DriverContext): Promise<string | null>;
}
