import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function verifyCantripOsSystemStatus({
  call,
  os,
  docker,
  container,
  name,
  root,
}) {
  const shell = (command, ...args) =>
    docker(
      "exec",
      "--user",
      "0",
      container,
      "sh",
      "-c",
      command,
      "fixture",
      ...args,
    );
  const imageId = await docker("inspect", "--format", "{{.Image}}", container);
  const image = JSON.parse(
    await docker("image", "inspect", "--format", "{{json .}}", imageId),
  );
  const status = () => call("GET", `/api/cantrip-os/${os.id}/system`);

  const tar = path.join(root, "empty-system-image.tar");
  await writeFile(tar, Buffer.alloc(1024));
  const tags = [`${name}:public`, `${name}:private`];
  const imported = [];
  const first = await (async () => {
    try {
      for (const [index, tag] of tags.entries()) {
        imported.push(
          await docker(
            "import",
            "--change",
            "LABEL io.cantrip.os=foundation",
            ...(index
              ? ["--change", "LABEL io.cantrip.os.system.checkpoint=private"]
              : []),
            tar,
            tag,
          ),
        );
      }
      const current = await status();
      assert.ok(
        current.bases.some(
          (base) => base.imageId === imported[0] && base.tags.includes(tags[0]),
        ),
        JSON.stringify(current),
      );
      assert.ok(current.bases.every((base) => base.imageId !== imported[1]));
      return current;
    } finally {
      if (imported.length)
        await docker("image", "rm", ...tags.slice(0, imported.length));
    }
  })();
  assert.equal(first.supported, true);
  assert.equal(first.error, null);
  assert.equal(first.target?.running, true, JSON.stringify(first));
  assert.equal(first.target.architecture, image.Architecture);
  assert.equal(first.target.attachmentGeneration, os.attachmentGeneration);
  assert.equal((await status()).target.generation, first.target.generation);

  const config = JSON.parse(await shell("cat /etc/cantrip-os/executor.json"));
  const identityPath = path.posix.join(config.state_dir, "instance.json");
  const saved = identityPath + ".fixture";
  const original = JSON.parse(await shell('cat "$1"', identityPath));
  // Docker returns a symlink entry, which must be followed inside the guest.
  await shell(
    'mv "$1" "$2" && ln -s "$(basename "$2")" "$1"',
    identityPath,
    saved,
  );
  assert.equal((await status()).target?.generation, first.target.generation);

  // The same retained physical container can still be managed if its guest
  // identity stops being readable, even after stopping the guest.
  await shell('rm "$1"', identityPath);
  const retained = await status();
  assert.equal(retained.target?.generation, first.target.generation);

  const foreign = {
    ...original,
    attachment: { ...original.attachment, owner_id: "foreign-account" },
  };
  await shell('printf "%s" "$2" > "$1"', identityPath, JSON.stringify(foreign));
  const rejected = await status();
  assert.equal(rejected.target, null);
  assert.match(rejected.error, /could not be observed/);
  assert.equal(await shell('cat "$1"', identityPath), JSON.stringify(foreign));

  await shell('mv "$2" "$1"', identityPath, saved);
  await docker("stop", "--time", "2", container);
  const stopped = await status();
  assert.equal(stopped.target?.running, false, JSON.stringify(stopped));
  assert.equal(stopped.target.generation, first.target.generation);
}
