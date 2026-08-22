import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { inspectRunConfigurations } from "./run-configuration-discovery.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const spectralLabConfiguration = `version = 1
name = "Spectral Lab"

[setup]
script = '''
cd "$CODEX_WORKTREE_PATH"
dotnet restore ./SpectralLab.slnx
'''

[setup.win32]
script = '''
Set-Location $env:CODEX_WORKTREE_PATH
dotnet restore .\\SpectralLab.slnx
'''

[[actions]]
name = "Run Spectral Lab"
icon = "run"
command = "dotnet run --project ./src/SpectralLab.App"
platform = "linux"

[[actions]]
name = "Run Spectral Lab"
icon = "run"
command = "dotnet run --project ./src/SpectralLab.App"
platform = "darwin"

[[actions]]
name = "Run Spectral Lab"
icon = "run"
command = '''
Set-Location $env:CODEX_WORKTREE_PATH
dotnet run --project .\\src\\SpectralLab.App\\SpectralLab.App.csproj
'''
platform = "win32"
`;

async function project(configuration?: string): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-run-configuration-"),
  );
  temporaryDirectories.push(root);
  if (configuration !== undefined) {
    const directory = path.join(root, ".codex", "environments");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "environment.toml"), configuration);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("inspectRunConfigurations", () => {
  it("treats a missing local environment as valid and unconfigured", async () => {
    const root = await project();
    await expect(
      inspectRunConfigurations(root, "darwin"),
    ).resolves.toMatchObject({
      platform: "darwin",
      configured: false,
      valid: true,
      canonical: { sourceControlState: "absent" },
      configurations: [],
    });
  });

  it("selects Spectral Lab setup and actions for the target worker platform", async () => {
    const root = await project(spectralLabConfiguration);
    const windows = await inspectRunConfigurations(root, "win32");
    const mac = await inspectRunConfigurations(root, "darwin");

    expect(windows).toMatchObject({
      platform: "win32",
      configured: true,
      valid: true,
      configurations: [
        {
          name: "Spectral Lab",
          version: 1,
          setup: {
            platform: "win32",
            command: expect.stringContaining("Set-Location"),
          },
          actions: [
            {
              name: "Run Spectral Lab",
              platform: "win32",
              sourceIndex: 2,
              command: expect.stringContaining("SpectralLab.App.csproj"),
            },
          ],
        },
      ],
    });
    expect(mac.configurations[0]?.setup).toMatchObject({
      platform: null,
      command: expect.stringContaining("dotnet restore"),
    });
    expect(mac.configurations[0]?.actions).toHaveLength(1);
    expect(mac.configurations[0]?.actions[0]?.platform).toBe("darwin");
    expect(mac.configurations[0]?.revision).toBe(
      windows.configurations[0]?.revision,
    );
  });

  it("keeps revisions and action IDs stable until file content or position changes", async () => {
    const root = await project(spectralLabConfiguration);
    const first = await inspectRunConfigurations(root, "linux");
    const second = await inspectRunConfigurations(root, "linux");
    expect(second.configurations[0]?.revision).toBe(
      first.configurations[0]?.revision,
    );
    expect(second.configurations[0]?.actions[0]?.id).toBe(
      first.configurations[0]?.actions[0]?.id,
    );

    await writeFile(
      path.join(root, ".codex", "environments", "environment.toml"),
      spectralLabConfiguration.replace("Spectral Lab", "Spectral Lab 2"),
    );
    const changed = await inspectRunConfigurations(root, "linux");
    expect(changed.configurations[0]?.revision).not.toBe(
      first.configurations[0]?.revision,
    );
    expect(changed.configurations[0]?.actions[0]?.id).toBe(
      first.configurations[0]?.actions[0]?.id,
    );
  });

  it("preserves script bytes while rejecting oversized configurations", async () => {
    const root = await project(`version = 1
name = "Whitespace"
[[actions]]
name = "Run"
icon = "run"
command = "  echo preserved  "
`);
    const inspection = await inspectRunConfigurations(root, "linux");
    expect(inspection.configurations[0]?.actions[0]?.command).toBe(
      "  echo preserved  ",
    );

    await writeFile(
      path.join(root, ".codex", "environments", "environment.toml"),
      `version = 1\nname = "${"x".repeat(512 * 1_024)}"`,
    );
    const oversized = await inspectRunConfigurations(root, "linux");
    expect(oversized.valid).toBe(false);
    expect(oversized.configurations[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "configuration-too-large" }),
      ]),
    );
  });

  it("reports malformed TOML and ambiguous platform-compatible names", async () => {
    const malformed = await project("version = [");
    const invalid = await inspectRunConfigurations(malformed, "linux");
    expect(invalid.valid).toBe(false);
    expect(invalid.configurations[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-toml", severity: "error" }),
      ]),
    );

    const duplicate = await project(`version = 1
name = "Duplicate"
[[actions]]
name = "Run"
icon = "run"
command = "first"
[[actions]]
name = "Run"
icon = "run"
command = "second"
`);
    const ambiguous = await inspectRunConfigurations(duplicate, "linux");
    expect(ambiguous.valid).toBe(true);
    expect(ambiguous.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ambiguous-action-name",
          severity: "warning",
        }),
      ]),
    );
  });

  it("distinguishes tracked, ignored, and untracked configuration", async () => {
    const tracked = await project(spectralLabConfiguration);
    await execFileAsync("git", ["init"], { cwd: tracked });
    await execFileAsync(
      "git",
      ["add", ".codex/environments/environment.toml"],
      { cwd: tracked },
    );
    expect(
      (await inspectRunConfigurations(tracked, "linux")).canonical
        .sourceControlState,
    ).toBe("tracked");

    const ignored = await project(spectralLabConfiguration);
    await execFileAsync("git", ["init"], { cwd: ignored });
    await writeFile(
      path.join(ignored, ".gitignore"),
      ".codex/environments/*.toml\n",
    );
    expect(
      (await inspectRunConfigurations(ignored, "linux")).canonical
        .sourceControlState,
    ).toBe("ignored");

    const untracked = await project(spectralLabConfiguration);
    await execFileAsync("git", ["init"], { cwd: untracked });
    expect(
      (await inspectRunConfigurations(untracked, "linux")).canonical
        .sourceControlState,
    ).toBe("untracked");
  });

  it.skipIf(process.platform === "win32")(
    "rejects configuration symlinks instead of following an escape",
    async () => {
      const root = await project();
      const directory = path.join(root, ".codex", "environments");
      await mkdir(directory, { recursive: true });
      const outside = await mkdtemp(
        path.join(os.tmpdir(), "cantrip-run-configuration-outside-"),
      );
      temporaryDirectories.push(outside);
      const target = path.join(outside, "environment.toml");
      await writeFile(target, spectralLabConfiguration);
      await symlink(target, path.join(directory, "environment.toml"));

      const inspection = await inspectRunConfigurations(root, "linux");
      expect(inspection.valid).toBe(false);
      expect(inspection.configurations).toEqual([]);
      expect(inspection.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "unsafe-configuration-file" }),
        ]),
      );
    },
  );
});
