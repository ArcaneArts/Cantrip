import path from "node:path";
import process from "node:process";

function isPnpmCli(file) {
  const name =
    file.split(/[\\/]/u).at(-1)?.toLowerCase() ?? path.basename(file);
  return name === "pnpm" || name.startsWith("pnpm.");
}

/**
 * Resolve pnpm to an executable JavaScript entrypoint when a script is running
 * under pnpm. Calling a `.cmd` shim directly through child_process fails on
 * current Windows Node releases unless a command shell is added. Reusing the
 * active pnpm CLI avoids that shell and preserves argument boundaries.
 */
export function pnpmCommand(
  arguments_,
  {
    environment = process.env,
    nodeExecutable = process.execPath,
    platform = process.platform,
  } = {},
) {
  const activeCli = environment.npm_execpath;
  if (activeCli && isPnpmCli(activeCli)) {
    return {
      command: nodeExecutable,
      arguments: [activeCli, ...arguments_],
    };
  }
  if (platform === "win32") {
    throw new Error(
      "Unable to locate the pnpm JavaScript entrypoint. Run this operation through a repository pnpm script.",
    );
  }
  return { command: "pnpm", arguments: arguments_ };
}
