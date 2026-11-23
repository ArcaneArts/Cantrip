/** Public diagnostics contain only a fixed restoration stage and an RPC code.
 * Native messages, paths and private Task contents remain in the local cause. */
export class TaskRestorationError extends Error {
  constructor(
    stage: "attach" | "admit" | "dispatch" | "resume" | "complete",
    cause: unknown,
    rpcCode?: number,
  ) {
    super(
      `Task restoration failed at ${stage}${rpcCode === undefined ? "." : ` (native RPC code ${rpcCode}).`}`,
      { cause },
    );
    this.name = "TaskRestorationError";
  }
}
