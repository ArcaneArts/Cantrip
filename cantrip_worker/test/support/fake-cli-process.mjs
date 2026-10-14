import { vi } from "vitest";

// Windows execFile/spawn cannot execute the extensionless shebang fixtures.
// Keep real child processes and argument boundaries. Registered Node fixtures
// run with Node; the one shell fixture uses Git Bash. Other calls stay untouched.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  const { promisify } = await import("node:util");
  const path = await import("node:path");
  const redirect = (command, args, ...rest) => {
    const fixture =
      process.platform === "win32"
        ? command === "gh"
          ? process.env.CANTRIP_TEST_FAKE_GH
          : command === "git"
            ? process.env.CANTRIP_TEST_FAKE_GIT
            : undefined
        : undefined;
    if (!fixture) return [command, args, ...rest];
    const shellFixture =
      command === "gh" && process.env.CANTRIP_TEST_FAKE_GH_SHELL === "true";
    return shellFixture
      ? [
          path.join(
            process.env.ProgramFiles ?? "C:\\Program Files",
            "Git",
            "bin",
            "bash.exe",
          ),
          [fixture.replace(/\\/gu, "/"), ...(args ?? [])],
          ...rest,
        ]
      : [process.execPath, [fixture, ...(args ?? [])], ...rest];
  };
  const execFile = Object.assign(
    (...args) => actual.execFile(...redirect(...args)),
    {
      [promisify.custom]: (...args) =>
        promisify(actual.execFile)(...redirect(...args)),
    },
  );
  return {
    ...actual,
    execFile,
    spawn: (...args) => actual.spawn(...redirect(...args)),
  };
});
