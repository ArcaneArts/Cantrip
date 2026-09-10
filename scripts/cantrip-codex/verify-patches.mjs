import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function verifyCodexPatchSeries(sourceDirectory, patches) {
  const temporary = await mkdtemp(path.join(tmpdir(), "cantrip-codex-verify-"));
  // A caller may itself be running inside a Git hook or an alternate worktree.
  // Keep every Git operation attached to the disposable repository below.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const runGit = (args) =>
    spawnSync("git", args, {
      cwd: temporary,
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    const initialized = runGit(["init", "--quiet"]);
    if (initialized.status !== 0) {
      throw new Error(
        `Cannot initialize temporary Codex patch verification repository:\n${initialized.error?.message ?? initialized.stderr ?? ""}`,
      );
    }
    // Copy the actual source that passed the manifest check, not HEAD or the
    // caller's index. Applying each patch makes its changes available to later
    // patches, matching the native build's ordered series.
    await cp(sourceDirectory, path.join(temporary, "source"), {
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    for (const patch of patches) {
      // File input avoids a synchronous parent/child pipe stall while preserving
      // the exact supplied bytes (which need not match a checked-in patch path).
      const patchFile = path.join(temporary, "current.patch");
      await writeFile(patchFile, patch.contents);
      const applied = runGit([
        "apply",
        "--ignore-space-change",
        "--directory=source",
        patchFile,
      ]);
      if (applied.status !== 0) {
        throw new Error(
          `Codex patch ${patch.name} does not apply cleanly:\n${applied.error?.message ?? applied.stderr ?? ""}`,
        );
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
