import assert from "node:assert/strict";
import test from "node:test";
import { containerRuntimeIdentity } from "./container-runtime-identity.mjs";

const imageId = "sha256:" + "a".repeat(64);
const executableSha256 = "b".repeat(64);
const manifestSha256 = "c".repeat(64);
const executable = "/opt/cantrip/bin/cantrip-server";
const manifest = {
  runtime: "rust",
  serverRequiresNode: false,
  target: "linux-arm64",
  version: { version: "1.1.3059" },
  files: [{ path: "bin/cantrip-server", sha256: executableSha256, bytes: 42 }],
};
const verifiedPackage = { imageId, manifestSha256, verifiedArtifactFiles: 1 };

function dockerFixture({
  currentImage = imageId,
  readOnly = true,
  mounts = ["/var/lib/cantrip"],
  tmpfs = { "/tmp": "noexec" },
  currentManifest = manifestSha256,
} = {}) {
  return async (operation, name, command, ...args) => {
    assert.equal(name, "cantrip-fixture");
    if (operation === "inspect")
      return JSON.stringify([
        {
          Image: currentImage,
          HostConfig: { ReadonlyRootfs: readOnly, Tmpfs: tmpfs },
          Mounts: mounts.map((Destination) => ({ Destination })),
        },
      ]);
    assert.equal(operation, "exec");
    if (command === "sh") return "/proc/42 1 direct";
    if (command === "od") {
      const header = Buffer.alloc(20);
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(header);
      header.writeUInt16LE(183, 18);
      return header.toString("hex");
    }
    if (command === "cat") return JSON.stringify(manifest);
    if (command === "readlink") return executable;
    assert.equal(command, "sha256sum");
    if (args[0] === "/proc/42/exe") return executableSha256;
    if (args[0] === "/opt/cantrip/native-server.json") return currentManifest;
    assert.deepEqual(args, ["--", executable]);
    return executableSha256 + "  " + executable;
  };
}

test("verifies all package files inside the running container by default", async () => {
  const result = await containerRuntimeIdentity(
    dockerFixture(),
    "cantrip-fixture",
    "arm64",
  );
  assert.equal(result.verifiedArtifactFiles, 1);
  assert.equal(result.sha256, executableSha256);
  assert.equal(result.packageVerifiedFromImmutableImage, undefined);
});

test("ties packaged files to the exact immutable image and still hashes the live executable", async () => {
  const result = await containerRuntimeIdentity(
    dockerFixture(),
    "cantrip-fixture",
    "arm64",
    { verifiedPackage },
  );
  assert.equal(result.packageVerifiedFromImmutableImage, true);
  assert.equal(result.verifiedArtifactFiles, 1);
  assert.equal(result.sha256, executableSha256);
});

for (const [name, options] of [
  ["a different image", { currentImage: "sha256:" + "e".repeat(64) }],
  ["a writable root", { readOnly: false }],
  ["a mount over the package", { mounts: ["/opt"] }],
  ["a tmpfs inside the package", { tmpfs: { "/opt/cantrip/lib": "noexec" } }],
  ["a different manifest", { currentManifest: "f".repeat(64) }],
]) {
  test(`rejects immutable-image verification for ${name}`, async () => {
    await assert.rejects(
      containerRuntimeIdentity(
        dockerFixture(options),
        "cantrip-fixture",
        "arm64",
        {
          verifiedPackage,
        },
      ),
      { name: "AssertionError" },
    );
  });
}
