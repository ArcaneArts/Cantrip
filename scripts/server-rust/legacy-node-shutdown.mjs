// Acceptance-only Windows adapter. EOF invokes the reference server's actual
// shutdown handlers, since Node's Windows SIGTERM uses TerminateProcess.
process.stdin.once("end", () => {
  process.stdin.pause();
  process.emit("SIGTERM");
});
process.stdin.resume();
