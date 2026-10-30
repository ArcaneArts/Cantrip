import { createDesktopAutomationClient } from "../../src/desktop/automation-client.js";

const before = {
  exit: process.listenerCount("exit"),
  SIGINT: process.listenerCount("SIGINT"),
  SIGTERM: process.listenerCount("SIGTERM"),
};
process.env.COMPUTER_USE_AUDIT_LOG = "false";
const client =
  process.argv[2] === "managed"
    ? await createDesktopAutomationClient()
    : await (async () => {
        const { createComputerUseServer } =
          await import("@zavora-ai/computer-use-mcp");
        const { connectInProcess } =
          await import("@zavora-ai/computer-use-mcp/client");
        return connectInProcess(
          createComputerUseServer({
            elicitApproval: async () => true,
            profile: "full",
          }),
        );
      })();
const added = {
  exit: process.listenerCount("exit") - before.exit,
  SIGINT: process.listenerCount("SIGINT") - before.SIGINT,
  SIGTERM: process.listenerCount("SIGTERM") - before.SIGTERM,
};
const signal = process.argv[3] === "SIGINT" ? "SIGINT" : "SIGTERM";
process.once(signal, () => {
  void client.close().then(() => {
    process.send?.({ event: "host-shutdown-completed" }, () => {
      process.disconnect();
    });
  });
});
// Windows cannot deliver Unix signals through ChildProcess.kill. Exercise the
// same real registered listeners there, including any process.exit handler.
process.on("message", (message) => {
  if (message === "terminate") process.emit(signal, signal);
});
process.send?.({ event: "ready", added });
