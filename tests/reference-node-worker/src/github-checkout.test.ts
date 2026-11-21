import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { GithubClient, githubRepositoryFromRemoteUrl } from "./github.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("attached checkout discovery", () => {
  it("recognizes common GitHub origin URL forms", () => {
    expect(
      githubRepositoryFromRemoteUrl("git@github.com:ArcaneArts/Cantrip.git"),
    ).toBe("arcanearts/cantrip");
    expect(
      githubRepositoryFromRemoteUrl(
        "https://github.com/ArcaneArts/Cantrip.git",
      ),
    ).toBe("arcanearts/cantrip");
    expect(
      githubRepositoryFromRemoteUrl(
        "ssh://git@github.com/ArcaneArts/Cantrip.git",
      ),
    ).toBe("arcanearts/cantrip");
    expect(
      githubRepositoryFromRemoteUrl("https://gitlab.com/ArcaneArts/Cantrip"),
    ).toBeNull();
  });

  it("enables local Git only when the attached folder is the checkout root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-checkout-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    const nested = path.join(repository, "nested");
    await mkdir(nested, { recursive: true });
    await execFileAsync("git", ["init", repository]);
    const client = new GithubClient(path.join(root, "worker-data"));

    await expect(
      client.inspectCheckout(await realpath(repository)),
    ).resolves.toMatchObject({
      github: null,
      repositoryFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    await expect(
      client.inspectCheckout(await realpath(nested)),
    ).resolves.toEqual({
      github: null,
      repositoryFingerprint: null,
    });
  });

  it("enables GitHub only when the checkout origin is accessible", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-checkout-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    await mkdir(repository, { recursive: true });
    await execFileAsync("git", ["init", repository]);
    await execFileAsync("git", [
      "-C",
      repository,
      "remote",
      "add",
      "origin",
      "git@github.com:ArcaneArts/Cantrip.git",
    ]);
    const client = new GithubClient(path.join(root, "worker-data"));
    const canonicalRepository = await realpath(repository);

    await expect(
      client.inspectCheckout(canonicalRepository, async (nameWithOwner) => {
        expect(nameWithOwner).toBe("arcanearts/cantrip");
        return {
          repositoryId: "12345",
          nameWithOwner: "ArcaneArts/Cantrip",
          url: "https://github.com/ArcaneArts/Cantrip",
        };
      }),
    ).resolves.toMatchObject({
      github: { nameWithOwner: "ArcaneArts/Cantrip" },
      repositoryFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    await expect(
      client.inspectCheckout(canonicalRepository, async () => {
        throw new Error("gh is not authenticated");
      }),
    ).resolves.toMatchObject({
      github: null,
      repositoryFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });
});
