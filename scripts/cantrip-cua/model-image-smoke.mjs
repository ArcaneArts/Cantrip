import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Exercise native Sharp/libvips using the final worker's dependency resolution.
 * Synthetic pixels only: no sidecar launch, capture, or operating-system access.
 * This verifies the packaged encoder, not the full managed MCP connection.
 */
export async function smokeCuaModelImageEncoder(workerRoot) {
  const requireWorker = createRequire(path.resolve(workerRoot, "package.json"));
  const sharp = requireWorker("sharp");
  const raw = Buffer.alloc(1024 * 768 * 4);
  let input;
  let output;
  let decoded;
  try {
    let state = 73;
    for (let offset = 0; offset < raw.length; offset += 4) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      raw.writeUInt32LE(state >>> 0, offset);
    }
    input = await sharp(raw, { raw: { width: 1024, height: 768, channels: 4 } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    assert.ok(
      input.length > 2.5 * 1024 * 1024,
      "fixture must require model resizing",
    );
    const scale = Math.sqrt(600_000 / (1024 * 768));
    output = await sharp(input, {
      limitInputPixels: 4_194_304,
      failOn: "warning",
    })
      .resize({
        width: Math.floor(1024 * scale),
        height: Math.floor(768 * scale),
        fit: "inside",
        withoutEnlargement: true,
      })
      .png({ palette: false, compressionLevel: 6 })
      .toBuffer({ resolveWithObject: true });
    assert.ok(output.data.length <= 2.5 * 1024 * 1024);
    assert.ok(output.info.width * output.info.height <= 600_000);
    assert.equal(output.data[25], 6, "full-colour RGBA PNG required");
    decoded = await sharp(output.data, {
      limitInputPixels: 600_000,
      failOn: "warning",
    })
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, output.info.width);
    assert.equal(decoded.info.height, output.info.height);
    assert.equal(decoded.info.channels, 4);
    return {
      sharpVersion: sharp.versions.sharp,
      inputBytes: input.length,
      outputBytes: output.data.length,
      width: output.info.width,
      height: output.info.height,
    };
  } finally {
    raw.fill(0);
    input?.fill(0);
    output?.data.fill(0);
    decoded?.data.fill(0);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 3)
    throw new Error(
      "Usage: node scripts/cantrip-cua/model-image-smoke.mjs <worker-directory>",
    );
  console.log(
    JSON.stringify(await smokeCuaModelImageEncoder(process.argv[2]), null, 2),
  );
}
