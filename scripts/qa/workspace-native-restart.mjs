/** One-shot QA restart policy; never turns a build error or graceful shutdown
 * into evidence of crash recovery. The runner invokes this only for its app. */
export function shouldRestartNativeFixture(result, environment) {
  return (
    (result.code === 0 &&
      result.signal === null &&
      environment.CANTRIP_QA_RESTART_ON_EXIT === "true") ||
    (result.code === null &&
      result.signal === "SIGKILL" &&
      environment.CANTRIP_QA_RESTART_AFTER_CRASH === "true")
  );
}
