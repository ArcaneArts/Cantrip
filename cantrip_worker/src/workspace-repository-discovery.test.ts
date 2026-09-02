import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { WorkspaceRepositoryDiscoveryProgress } from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyWorkspaceRepositoryOrigin,
  discoverWorkspaceRepositories,
  parseGithubRepositoryOrigin,
  validateWorkspaceRepositoryImport,
} from "./workspace-repository-discovery.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-discovery-"));
  temporaryDirectories.push(root);
  return root;
}

async function initializeRepository(repository: string): Promise<void> {
  await mkdir(repository, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", repository]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("discoverWorkspaceRepositories", () => {
  it("finds primary repositories through depth three and stops at repository roots", async () => {
    const root = await temporaryRoot();
    const rootRepository = path.join(root, "root-repository");
    const depthThreeRepository = path.join(root, "one", "two", "repository");
    const tooDeepRepository = path.join(
      root,
      "one",
      "two",
      "three",
      "repository",
    );
    const nestedRepository = path.join(rootRepository, "vendor", "nested");
    await initializeRepository(rootRepository);
    await initializeRepository(depthThreeRepository);
    await initializeRepository(tooDeepRepository);
    await initializeRepository(nestedRepository);

    const progress: WorkspaceRepositoryDiscoveryProgress[] = [];
    const result = await discoverWorkspaceRepositories(root, {}, (update) =>
      progress.push(update),
    );

    expect(result.candidates.map(({ relativePath }) => relativePath)).toEqual([
      "one/two/repository",
      "root-repository",
    ]);
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "local-git",
          diagnosticCode: null,
          github: null,
          originUrl: null,
          repositoryFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }),
      ]),
    );
    expect(result.truncated).toBe(true);
    expect(progress[0]?.counts).toMatchObject({
      candidates: 0,
      scannedDirectories: 0,
    });
    expect(progress.at(-1)).toMatchObject({
      counts: { candidates: 2 },
      truncated: true,
    });
  });

  it("does not follow directory symlinks outside the attached root", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await initializeRepository(path.join(outside, "repository"));
    await symlink(outside, path.join(root, "outside-link"), "dir");

    const result = await discoverWorkspaceRepositories(root);

    expect(result.candidates).toEqual([]);
    expect(result.skippedSymlinks).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("retains protected-review metadata for non-GitHub origins", async () => {
    const root = await temporaryRoot();
    const repository = path.join(root, "gitlab-repository");
    await initializeRepository(repository);
    await execFileAsync("git", [
      "-C",
      repository,
      "remote",
      "add",
      "origin",
      "ssh://git@gitlab.com/team/repository.git",
    ]);

    const result = await discoverWorkspaceRepositories(root);

    expect(result.candidates).toEqual([
      expect.objectContaining({
        classification: "local-git",
        diagnosticCode: null,
        github: null,
        originUrl: "ssh://git@gitlab.com/team/repository.git",
      }),
    ]);
  });

  it("recognizes git marker files but excludes linked worktrees", async () => {
    const root = await temporaryRoot();
    const primary = path.join(root, "primary");
    const linked = path.join(root, "linked");
    await initializeRepository(primary);
    await execFileAsync("git", [
      "-C",
      primary,
      "config",
      "user.email",
      "test@example.com",
    ]);
    await execFileAsync("git", [
      "-C",
      primary,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await writeFile(path.join(primary, "README.md"), "test");
    await execFileAsync("git", ["-C", primary, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      primary,
      "commit",
      "--quiet",
      "-m",
      "initial",
    ]);
    await execFileAsync("git", [
      "-C",
      primary,
      "worktree",
      "add",
      "--quiet",
      linked,
    ]);

    const result = await discoverWorkspaceRepositories(root);

    expect(result.candidates.map(({ relativePath }) => relativePath)).toEqual([
      "primary",
    ]);
    expect(result.rejectedRepositories).toBe(1);
  });

  it("reports bare repositories and standalone linked worktrees as unsupported", async () => {
    const root = await temporaryRoot();
    const primaryRoot = await temporaryRoot();
    const primary = path.join(primaryRoot, "primary");
    const linked = path.join(root, "linked");
    const bare = path.join(root, "bare.git");
    await initializeRepository(primary);
    await execFileAsync("git", [
      "-C",
      primary,
      "config",
      "user.email",
      "test@example.com",
    ]);
    await execFileAsync("git", [
      "-C",
      primary,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await writeFile(path.join(primary, "README.md"), "test");
    await execFileAsync("git", ["-C", primary, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      primary,
      "commit",
      "--quiet",
      "-m",
      "initial",
    ]);
    await execFileAsync("git", [
      "-C",
      primary,
      "worktree",
      "add",
      "--quiet",
      linked,
    ]);
    await execFileAsync("git", ["init", "--bare", "--quiet", bare]);

    const result = await discoverWorkspaceRepositories(root);

    expect(result.candidates).toEqual([
      expect.objectContaining({
        relativePath: "bare.git",
        classification: "unsupported",
        diagnosticCode: "bare-repository",
      }),
      expect.objectContaining({
        relativePath: "linked",
        classification: "unsupported",
        diagnosticCode: "linked-worktree",
      }),
    ]);
    expect(result.rejectedRepositories).toBe(2);
    await expect(
      validateWorkspaceRepositoryImport({
        attempt: 1,
        candidateId: "7c23b8ff-a03a-4ffc-9c33-98a8ab722ee7",
        expectedRepositoryFingerprint:
          result.candidates[1]!.repositoryFingerprint,
        path: linked,
        rootPath: root,
      }),
    ).rejects.toMatchObject({ code: "repository-unavailable" });
  });

  it("applies candidate and entry bounds", async () => {
    const root = await temporaryRoot();
    await initializeRepository(path.join(root, "a"));
    await initializeRepository(path.join(root, "b"));

    const result = await discoverWorkspaceRepositories(root, {
      maxCandidates: 1,
      maxEntries: 100,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.scannedEntries).toBeGreaterThan(0);
    expect(await realpath(result.canonicalRoot)).toBe(await realpath(root));
  });

  it("rejects relative roots and ignores ordinary non-Git directories", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "ordinary", "nested"), { recursive: true });

    await expect(
      discoverWorkspaceRepositories("relative/workspace"),
    ).rejects.toMatchObject({
      code: "root-unavailable",
      message: expect.stringMatching(/absolute root/iu),
    });
    await expect(discoverWorkspaceRepositories(root)).resolves.toMatchObject({
      candidates: [],
    });
  });

  it("revalidates the same checkout inside the attached root", async () => {
    const root = await temporaryRoot();
    const repository = path.join(root, "repository");
    await initializeRepository(repository);
    const discovered = await discoverWorkspaceRepositories(root);
    const candidate = discovered.candidates[0]!;

    await expect(
      validateWorkspaceRepositoryImport({
        attempt: 2,
        candidateId: "fe47e031-8924-44c0-9b51-677fc23397ca",
        expectedRepositoryFingerprint: candidate.repositoryFingerprint,
        path: repository,
        rootPath: root,
      }),
    ).resolves.toMatchObject({
      attempt: 2,
      classification: "local-git",
      repositoryFingerprint: candidate.repositoryFingerprint,
    });
  });

  it("rejects stale or out-of-root import candidates", async () => {
    const root = await temporaryRoot();
    const repository = path.join(root, "repository");
    const outside = await temporaryRoot();
    const outsideRepository = path.join(outside, "repository");
    await initializeRepository(repository);
    await initializeRepository(outsideRepository);
    const [candidate] = (await discoverWorkspaceRepositories(root)).candidates;
    const input = {
      attempt: 1,
      candidateId: "fe47e031-8924-44c0-9b51-677fc23397ca",
      expectedRepositoryFingerprint: candidate!.repositoryFingerprint,
      rootPath: root,
    };

    await expect(
      validateWorkspaceRepositoryImport({
        ...input,
        expectedRepositoryFingerprint: "f".repeat(64),
        path: repository,
      }),
    ).rejects.toMatchObject({ code: "repository-changed" });
    await expect(
      validateWorkspaceRepositoryImport({
        ...input,
        path: outsideRepository,
      }),
    ).rejects.toMatchObject({ code: "repository-unavailable" });
  });

  it("recognizes only supported GitHub.com SSH and HTTPS origins", () => {
    expect(
      parseGithubRepositoryOrigin("git@github.com:ArcaneArts/Cantrip.git"),
    ).toEqual({
      nameWithOwner: "ArcaneArts/Cantrip",
      url: "https://github.com/ArcaneArts/Cantrip",
    });
    expect(
      parseGithubRepositoryOrigin(
        "ssh://git@github.com/ArcaneArts/Cantrip.git",
      ),
    ).toEqual({
      nameWithOwner: "ArcaneArts/Cantrip",
      url: "https://github.com/ArcaneArts/Cantrip",
    });
    expect(
      parseGithubRepositoryOrigin("https://github.com/ArcaneArts/Cantrip.git/"),
    ).toEqual({
      nameWithOwner: "ArcaneArts/Cantrip",
      url: "https://github.com/ArcaneArts/Cantrip",
    });
    expect(
      parseGithubRepositoryOrigin("https://git.example.com/owner/repository"),
    ).toBeNull();
    expect(
      parseGithubRepositoryOrigin("https://token@github.com/owner/repository"),
    ).toBeNull();
  });

  it("classifies an accessible GitHub origin using the actual API operation", async () => {
    const githubApi = vi.fn().mockResolvedValue({
      id: 1234,
      full_name: "ArcaneArts/Cantrip",
      html_url: "https://github.com/ArcaneArts/Cantrip",
    });

    await expect(
      classifyWorkspaceRepositoryOrigin(
        "git@github.com:ArcaneArts/Cantrip.git",
        { githubApi, maxBuffer: 1_024, timeout: 500 },
      ),
    ).resolves.toEqual({
      classification: "github-accessible",
      diagnosticCode: null,
      github: {
        repositoryId: "1234",
        nameWithOwner: "ArcaneArts/Cantrip",
        url: "https://github.com/ArcaneArts/Cantrip",
      },
      originUrl: "git@github.com:ArcaneArts/Cantrip.git",
    });
    expect(githubApi).toHaveBeenCalledWith("ArcaneArts/Cantrip", {
      maxBuffer: 1_024,
      timeout: 500,
    });
  });

  it("keeps inaccessible GitHub and non-GitHub origins locally importable", async () => {
    await expect(
      classifyWorkspaceRepositoryOrigin(
        "https://github.com/ArcaneArts/Private.git",
        {
          githubApi: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error("missing"), { code: "ENOENT" }),
            ),
          maxBuffer: 1_024,
          timeout: 500,
        },
      ),
    ).resolves.toEqual({
      classification: "github-unavailable",
      diagnosticCode: "github-cli-unavailable",
      github: null,
      originUrl: "https://github.com/ArcaneArts/Private.git",
    });
    await expect(
      classifyWorkspaceRepositoryOrigin(
        "https://github.com/ArcaneArts/Expected.git",
        {
          githubApi: vi.fn().mockResolvedValue({
            id: 1234,
            full_name: "ArcaneArts/Different",
            html_url: "https://github.com/ArcaneArts/Different",
          }),
          maxBuffer: 1_024,
          timeout: 500,
        },
      ),
    ).resolves.toEqual({
      classification: "github-unavailable",
      diagnosticCode: "github-identity-mismatch",
      github: null,
      originUrl: "https://github.com/ArcaneArts/Expected.git",
    });
    await expect(
      classifyWorkspaceRepositoryOrigin("ssh://git@gitlab.com/team/repo.git", {
        githubApi: vi.fn(),
        maxBuffer: 1_024,
        timeout: 500,
      }),
    ).resolves.toEqual({
      classification: "local-git",
      diagnosticCode: null,
      github: null,
      originUrl: "ssh://git@gitlab.com/team/repo.git",
    });
  });
});
