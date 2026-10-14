import { vi } from "vitest";

// Windows execFile/spawn cannot execute the extensionless shebang fixtures.
// Keep real child processes and argument boundaries; Git Bash launches only the
// explicitly registered test executables. Ordinary Git/gh calls stay untouched.
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
    return [
      path.join(
        process.env.ProgramFiles ?? "C:\\Program Files",
        "Git",
        "bin",
        "bash.exe",
      ),
      [
        "-c",
        'MSYS2_ARG_CONV_EXCL="*" exec "$@"',
        "cantrip-test-cli",
        fixture.replace(/\\/gu, "/"),
        ...(args ?? []),
      ],
      ...rest,
    ];
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
