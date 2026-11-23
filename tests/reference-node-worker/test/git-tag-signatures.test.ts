import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGitTagDetail, readGitTags } from "../src/git.js";

const exec = promisify(execFile);
let root: string;
let repo: string;
let signers: string;
let publicKey: string;

const git = (...args: string[]) => exec("git", ["-C", repo, ...args]);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cantrip-tag-signature-"));
  repo = path.join(root, "repo");
  const key = path.join(root, "signing-key");
  signers = path.join(root, "allowed-signers");
  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  publicKey = (await readFile(`${key}.pub`, "utf8")).trim();
  await writeFile(signers, `qa@cantrip.test ${publicKey}\n`);
  await exec("git", ["init", "-b", "main", repo]);
  await git("config", "user.name", "Cantrip QA");
  await git("config", "user.email", "qa@cantrip.test");
  await git("config", "gpg.format", "ssh");
  await git("config", "user.signingKey", key);
  await git("config", "gpg.ssh.allowedSignersFile", signers);
  await git(
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--allow-empty",
    "-m",
    "Fixture",
  );
  await git("tag", "-s", "signed", "-m", "Signed fixture");
  await git(
    "-c",
    "tag.gpgSign=false",
    "tag",
    "-a",
    "unsigned",
    "-m",
    "Unsigned fixture",
  );
  const original = (await git("cat-file", "tag", "signed")).stdout;
  const tampered = original
    .replace("tag signed\n", "tag tampered\n")
    .replace("Signed fixture\n", "Tampered fixture\n");
  await writeFile(path.join(root, "tampered-tag"), tampered);
  const hash = (
    await git("hash-object", "-t", "tag", "-w", path.join(root, "tampered-tag"))
  ).stdout.trim();
  await git("update-ref", "refs/tags/tampered", hash);
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function listAndDetail(name: string) {
  const summary = (await readGitTags(repo)).tags.find(
    (tag) => tag.name === name,
  )!;
  const detail = await readGitTagDetail(repo, name);
  expect(summary).toBeDefined();
  expect(summary.hash).toBe(detail.hash);
  expect(summary.signature).toEqual(detail.signature);
  return summary.signature;
}

describe("annotated tag signature verification", () => {
  it("verifies the tag object even when its ref name resembles an option", async () => {
    const hash = (await git("rev-parse", "refs/tags/signed")).stdout.trim();
    await git("update-ref", "refs/tags/-signed", hash);
    expect(await listAndDetail("-signed")).toMatchObject({
      format: "ssh",
      status: "valid",
      verification: "available",
    });
  });

  it("does not present a signed target commit as a signed lightweight tag", async () => {
    await git("commit", "-S", "--allow-empty", "-m", "Signed target");
    await git("-c", "tag.gpgSign=false", "tag", "lightweight");
    expect(await listAndDetail("lightweight")).toMatchObject({
      format: null,
      status: "unsigned",
      verification: "not-applicable",
    });
  });

  it("verifies the immutable signed tag object consistently in list and detail", async () => {
    const verified = await git("verify-tag", "--raw", "signed");
    expect(verified.stderr).toContain('Good "git" signature');
    expect(await listAndDetail("signed")).toMatchObject({
      format: "ssh",
      status: "valid",
      verification: "available",
    });
  });

  it("classifies an actually incorrect signature as invalid, not unavailable", async () => {
    await expect(git("verify-tag", "--raw", "tampered")).rejects.toMatchObject({
      stderr: expect.stringContaining("incorrect signature"),
    });
    expect(await listAndDetail("tampered")).toMatchObject({
      format: "ssh",
      status: "invalid",
      verification: "available",
      verificationMessage: expect.stringContaining("incorrect signature"),
    });
  });

  it("leaves unsigned annotated tags unsigned without a verification error", async () => {
    expect(await listAndDetail("unsigned")).toMatchObject({
      format: null,
      status: "unsigned",
      verification: "not-applicable",
      verificationMessage: null,
    });
  });

  it("honestly reports missing allowed-signers configuration", async () => {
    await git("config", "--unset", "gpg.ssh.allowedSignersFile");
    expect(await listAndDetail("signed")).toMatchObject({
      format: "ssh",
      status: "unverifiable",
      verification: "missing-config",
    });
  });

  it("honestly reports an unavailable verification tool", async () => {
    await git("config", "gpg.ssh.program", path.join(root, "missing-verifier"));
    expect(await listAndDetail("signed")).toMatchObject({
      format: "ssh",
      status: "unverifiable",
      verification: "missing-tool",
    });
  });

  it("does not keep stale trust after the same allowed-signers file changes", async () => {
    expect(await listAndDetail("signed")).toMatchObject({ status: "valid" });
    await writeFile(signers, `other@cantrip.test ${publicKey}\n`);
    // The key remains trusted under another principal, so the actual verifier
    // decides the signer; the tag name and signature object are unchanged.
    const outcome = await git("verify-tag", "--raw", "signed");
    expect(outcome.stderr).toContain("other@cantrip.test");
    expect(await listAndDetail("signed")).toMatchObject({ status: "valid" });
    await writeFile(signers, "");
    await expect(git("verify-tag", "--raw", "signed")).rejects.toMatchObject({
      stderr: expect.stringContaining("No principal matched"),
    });
    expect(await listAndDetail("signed")).toMatchObject({
      format: "ssh",
      status: "valid-unknown",
      verification: "available",
    });
  });
});
