import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { LocalDocker } from "@cantrip/os-host";
import {
  cantripOsPackageExpectedSchema,
  cantripOsSystemTargetSchema,
  type CantripOsSystemScope,
  type CantripOsSystemTarget,
} from "@cantrip/protocol";

const identitySchema = z
  .object({
    version: z.literal(1),
    instance_id: z.uuid(),
    attachment: z
      .object({
        owner_id: z.string().min(1).max(200),
        worker_id: z.string().min(1).max(200),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();
const canonical = (path: string) => {
  if (
    !path.startsWith("/") ||
    posix.normalize(path) !== path ||
    path.includes("\0")
  )
    throw new Error("A canonical guest identity path is required");
  return path;
};
export const systemTargetAuthority = (target: CantripOsSystemTarget) => [
  target.containerId,
  target.containerName,
  target.imageId,
  target.expected.guestInstanceId,
  target.expected.ownerId,
  target.expected.workerId,
];
/** Read-only Docker archive decoding. No guest process/helper is needed, and no
 * archive pathname is ever extracted onto the host. The complete tar is bounded. */
export async function readSystemFile(
  engine: LocalDocker,
  containerId: string,
  path: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  let selected = canonical(path);
  for (let hop = 0; hop <= 40; hop++) {
    const stream = await engine.readStream(
      `/containers/${containerId}/archive?path=${encodeURIComponent(selected)}`,
      { signal },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const bytes of stream) {
        signal?.throwIfAborted();
        size += bytes.length;
        if (size > 2 * 1024 * 1024)
          throw new Error(
            "The guest identity archive exceeds its metadata limit",
          );
        chunks.push(Buffer.from(bytes));
      }
    } finally {
      stream.destroy();
    }
    const tar = Buffer.concat(chunks);
    let body: Buffer | undefined,
      link: string | undefined,
      paxLink: string | undefined,
      ended = false;
    for (let offset = 0; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512);
      offset += 512;
      if (header.every((byte) => byte === 0)) {
        if (
          offset + 512 > tar.length ||
          tar.subarray(offset).some((byte) => byte !== 0)
        )
          throw new Error("Guest identity archive terminator changed");
        ended = true;
        break;
      }
      const checksum = Number.parseInt(
        header.subarray(148, 156).toString().replace(/\0/g, "").trim(),
        8,
      );
      let actual = 0;
      for (let i = 0; i < 512; i++)
        actual += i >= 148 && i < 156 ? 32 : header[i]!;
      const text = header
        .subarray(124, 136)
        .toString()
        .replace(/\0/g, "")
        .trim();
      if (!/^[0-7]+$/.test(text) || checksum !== actual)
        throw new Error("Invalid guest identity archive header");
      const bytes = Number.parseInt(text, 8),
        kind = header[156];
      if (bytes > 1024 * 1024 || offset + bytes > tar.length)
        throw new Error("Guest identity archive is incomplete or too large");
      if (kind === 0 || kind === 48) {
        if (body || link)
          throw new Error("Guest identity archive contains more than one file");
        body = Buffer.from(tar.subarray(offset, offset + bytes));
      } else if (kind === 50) {
        if (body || link || bytes)
          throw new Error("Invalid guest identity symlink archive");
        link = paxLink ?? header.subarray(157, 257).toString().split("\0")[0];
      } else if (kind === 120 || kind === 103) {
        const data = tar.subarray(offset, offset + bytes);
        for (let cursor = 0; cursor < data.length;) {
          const space = data.indexOf(32, cursor),
            length = Number(data.subarray(cursor, space).toString());
          if (
            space < cursor ||
            !Number.isSafeInteger(length) ||
            length <= space - cursor + 1 ||
            cursor + length > data.length ||
            data[cursor + length - 1] !== 10
          )
            throw new Error("Invalid guest identity PAX metadata");
          const item = new TextDecoder("utf-8", { fatal: true }).decode(
            data.subarray(space + 1, cursor + length - 1),
          );
          if (item.startsWith("linkpath=")) paxLink = item.slice(9);
          cursor += length;
        }
      } else if (kind === 76 || kind === 75) {
        if (kind === 75)
          paxLink = new TextDecoder("utf-8", { fatal: true })
            .decode(tar.subarray(offset, offset + bytes))
            .split("\0")[0];
      } else throw new Error("The guest identity path is not a regular file");
      offset += Math.ceil(bytes / 512) * 512;
    }
    if (!ended)
      throw new Error("Guest identity archive has no complete terminator");
    if (body) return body;
    if (!link) throw new Error("The guest identity archive has no file");
    selected = canonical(posix.resolve(posix.dirname(selected), link));
  }
  throw new Error("The guest identity symlink chain is too long");
}
export async function readSystemIdentity(
  engine: LocalDocker,
  containerId: string,
  knownPath?: string,
  signal?: AbortSignal,
) {
  let path: string;
  try {
    const config = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readSystemFile(
          engine,
          containerId,
          "/etc/cantrip-os/executor.json",
          signal,
        ),
      ),
    );
    const state = z.string().parse(config.state_dir);
    if (!state.startsWith("/") || state.includes("\0"))
      throw new Error("The configured executor state path is not absolute");
    path = posix.join(posix.resolve(state), "instance.json");
  } catch (error) {
    if (!knownPath) throw error;
    path = canonical(knownPath);
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readSystemFile(engine, containerId, path, signal),
      ),
    );
  } catch (error) {
    if (!knownPath || path === knownPath) throw error;
    path = canonical(knownPath);
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readSystemFile(engine, containerId, path, signal),
      ),
    );
  }
  // A valid foreign identity must never fall back to an old matching file.
  return { identity: identitySchema.parse(value), identityPath: path };
}
export async function systemTarget(
  engine: LocalDocker,
  reference: string,
  scope: CantripOsSystemScope,
  previous?: CantripOsSystemTarget,
  signal?: AbortSignal,
  allowChangedGuest = false,
) {
  const actual = await engine.inspect<{
    Id: string;
    Name: string;
    Image: string;
    Config: { Labels: Record<string, string> };
    State: { Running: boolean };
  }>(reference, { signal });
  if (
    !/^[a-f0-9]{64}$/.test(actual.Id) ||
    actual.Config.Labels?.["io.cantrip.os"] !== "foundation"
  )
    throw new Error("The exact CantripOS Docker target is unavailable");
  const prior =
    previous?.containerId === actual.Id &&
    previous.containerName === actual.Name.slice(1) &&
    previous.expected.ownerId === scope.ownerId &&
    previous.expected.workerId === scope.workerId &&
    (allowChangedGuest ||
      previous.expected.guestInstanceId === scope.guestInstanceId)
      ? previous
      : undefined;
  let expected,
    identityEvidence: "guest-identity" | "retained-container" =
      "guest-identity";
  try {
    const current = await readSystemIdentity(
      engine,
      actual.Id,
      prior?.expected.identityPath,
      signal,
    );
    if (
      current.identity.attachment?.owner_id !== scope.ownerId ||
      current.identity.attachment.worker_id !== scope.workerId ||
      (!allowChangedGuest &&
        current.identity.instance_id !== scope.guestInstanceId)
    )
      throw Object.assign(
        new Error(
          "The system target's persistent owner/Worker/guest identity changed",
        ),
        { identityMismatch: true },
      );
    expected = cantripOsPackageExpectedSchema.parse({
      guestInstanceId: current.identity.instance_id,
      ownerId: scope.ownerId,
      workerId: scope.workerId,
      identityPath: current.identityPath,
    });
  } catch (error) {
    if (!prior || Reflect.get(Object(error), "identityMismatch")) throw error;
    // Only an already verified exact physical container can retain management
    // authority when its own identity/configuration files are broken.
    expected = prior.expected;
    identityEvidence = "retained-container";
  }
  let architecture: string | null = null;
  try {
    architecture = (
      await engine.request<{ Architecture: string }>(
        "GET",
        `/images/${encodeURIComponent(actual.Image)}/json`,
        undefined,
        { signal },
      )
    ).Architecture;
  } catch {
    signal?.throwIfAborted(); /* Missing optional image metadata does not revoke proven container management authority. */
  }
  const identity = {
    expected,
    containerId: actual.Id,
    containerName: actual.Name.slice(1),
    imageId: actual.Image,
    architecture,
    identityEvidence,
  };
  const next = cantripOsSystemTargetSchema.parse({
    generation: previous?.generation ?? randomUUID(),
    ...identity,
  });
  if (
    previous &&
    !isDeepStrictEqual(
      systemTargetAuthority(previous),
      systemTargetAuthority(next),
    )
  )
    next.generation = randomUUID();
  return { target: next, running: actual.State.Running };
}
