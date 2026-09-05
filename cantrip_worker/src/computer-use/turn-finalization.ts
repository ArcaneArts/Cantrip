/** Complete the actual runtime invocation, release its native/CUA lifetime, and
 * settle its protected history before the worker sends a terminal response.
 * Cleanup and publication failures never replace an existing runtime failure. */
export async function finalizeCuaAgentTurn<T>(
  run: () => Promise<T>,
  release: () => Promise<void>,
  drain: () => Promise<void>,
): Promise<T> {
  let value!: T;
  let failed = false;
  let failure: unknown;
  try {
    value = await run();
  } catch (error) {
    failed = true;
    failure = error;
  }
  for (const finish of [release, drain]) {
    try {
      await finish();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
  return value;
}
