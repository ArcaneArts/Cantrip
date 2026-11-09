import assert from "node:assert/strict";

// Inspect the running server's executable after a real request succeeds. Image
// metadata and uname alone can conceal an x64 executable under ARM emulation.
export async function containerRuntimeIdentity(
  docker,
  name,
  imageArchitecture,
) {
  const processes = (
    await docker(
      "exec",
      name,
      "sh",
      "-c",
      'for p in /proc/[0-9]*; do parent=$(awk \'/^PPid:/ {print $2}\' "$p/status" 2>/dev/null); if [ "$(readlink "$p/exe")" = /opt/cantrip/bin/cantrip-server ]; then echo "$p $parent direct"; elif [ -r "$p/maps" ]; then awk -v p="$p" -v parent="$parent" \'$NF == "/opt/cantrip/bin/cantrip-server" {print p " " parent " mapped " $5; exit}\' "$p/maps"; fi; done',
    )
  )
    .split("\n")
    .filter(Boolean);
  const candidates = processes.map((line) => line.split(" "));
  const directories = new Set(candidates.map(([directory]) => directory));
  const roots = candidates.filter(
    ([, parent]) => !directories.has("/proc/" + parent),
  );
  // Native PGlite's child uses the same executable. Select the service parent,
  // retaining its child identities rather than confusing them with duplicates.
  assert.equal(roots.length, 1, "one actual production server process tree");
  const [processDirectory, , observation, mappedInode] = roots[0];
  const processExecutable = processDirectory + "/exe";
  let executable = processExecutable;
  if (observation === "mapped") {
    // Rosetta's /proc/<pid>/exe identifies its ARM interpreter. Its maps still
    // identifies the x64 input inode. Hash that same inode on the immutable
    // container root, rather than mislabeling the interpreter as the server.
    const state = JSON.parse(await docker("inspect", name))[0];
    assert.equal(state.HostConfig.ReadonlyRootfs, true);
    executable = "/opt/cantrip/bin/cantrip-server";
    assert.equal(
      await docker("exec", name, "stat", "-Lc", "%i", executable),
      mappedInode,
    );
  }
  const header = Buffer.from(
    (
      await docker("exec", name, "od", "-An", "-v", "-tx1", "-N20", executable)
    ).replaceAll(/\s/g, ""),
    "hex",
  );
  assert.equal(header.length, 20);
  assert.equal(header.subarray(0, 4).toString("hex"), "7f454c46");
  assert.equal(header[4], 2, "64-bit ELF executable");
  assert.equal(header[5], 1, "little-endian ELF executable");
  const machine = header.readUInt16LE(18);
  const architecture = new Map([
    [62, "amd64"],
    [183, "arm64"],
  ]).get(machine);
  assert.equal(architecture, imageArchitecture);
  const sha256 = (await docker("exec", name, "sha256sum", executable)).split(
    /\s+/,
  )[0];
  const manifest = JSON.parse(
    await docker("exec", name, "cat", "/opt/cantrip/native-server.json"),
  );
  assert.equal(manifest.runtime, "rust");
  assert.equal(manifest.serverRequiresNode, false);
  assert.equal(
    manifest.target,
    architecture === "amd64" ? "linux-x64" : "linux-arm64",
  );
  const server = manifest.files.find(
    (file) => file.path === "bin/cantrip-server",
  );
  assert.ok(server, "artifact manifest records the executed server");
  assert.equal(sha256, server.sha256);
  const checksums = await docker(
    "exec",
    name,
    "sha256sum",
    "--",
    ...manifest.files.map((file) => "/opt/cantrip/" + file.path),
  );
  assert.equal(
    checksums,
    manifest.files
      .map((file) => file.sha256 + "  /opt/cantrip/" + file.path)
      .join("\n"),
    "all actual packaged files match the artifact manifest",
  );
  return {
    processExecutable,
    serverProcessDirectories: [...directories],
    observedExecutable: await docker(
      "exec",
      name,
      "readlink",
      processExecutable,
    ),
    observation,
    ...(mappedInode ? { mappedInode } : {}),
    elfMachine: machine,
    architecture,
    sha256,
    bytes: server.bytes,
    verifiedArtifactFiles: manifest.files.length,
    artifactTarget: manifest.target,
    artifactVersion: manifest.version,
  };
}
