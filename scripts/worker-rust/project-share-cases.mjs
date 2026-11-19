import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import * as crypto from "../../packages/crypto/dist/index.js";
import { workerLinkTunnelGrantSchema } from "../../packages/protocol/dist/worker-link.js";
import { openTunnelDataFrame } from "../../cantrip_worker/src/tunnel-data-protection.ts";
import { parseWebdavResponse } from "../server-rust/project-share-webdav.mjs";
import {
  Connection,
  openDirectTunnel,
  openLegacyTunnel,
} from "./worker-link-tunnel-cases.mjs";

const credit = 1024 * 1024;

export async function verifyNetworkShares({
  call,
  origin,
  ownerId,
  workerId,
  workerDirectory,
  serverId,
  projectId,
  checkout,
  master,
  eventually,
}) {
  async function request(method, url, status, body) {
    const response = await call(method, url, body);
    assert.equal(response.status, status, JSON.stringify(response));
    return response.body;
  }
  const component = "tunnel-content";
  const keyRevision = 1;
  const componentKey = crypto.deriveComponentKey({
    accountMasterKey: master,
    ownerId,
    component,
    keyRevision,
  });
  const labels = crypto.deriveComponentKey({
    accountMasterKey: master,
    ownerId,
    component: "private-surface-metadata",
    keyRevision,
  });
  try {
    const identity = JSON.parse(
      await readFile(
        path.join(workerDirectory, "worker-encryption-key.json"),
        "utf8",
      ),
    );
    await request(
      "POST",
      `/api/encryption/principals/${identity.principalId}/grants`,
      201,
      {
        component,
        keyRevision,
        wrappedKey: await crypto.wrapComponentKeyForWorker({
          ownerId,
          workerId,
          component,
          keyRevision,
          componentKey,
          workerPublicKey: identity.publicKey,
        }),
      },
    );
    const refresh = await request(
      "POST",
      `/api/workers/${workerId}/encryption/refresh`,
      200,
      { component, keyRevision },
    );
    assert.equal(refresh.status.state, "ready");
    const makeShare = async (destination) => {
      const tunnelId = randomUUID();
      const binding = {
        publicBasePath:
          "/project-shares/" + randomBytes(32).toString("base64url"),
        publicOrigin: "http://127.0.0.1",
        username: "cantrip-native-share",
        password: randomBytes(24).toString("base64url"),
        realm: "Cantrip Private Share",
      };
      const dataProtection = {
        formatVersion: 1,
        keyRevision,
        algorithm: "AES-256-GCM",
        key: randomBytes(32).toString("base64url"),
      };
      const record = {
        name: "Native WebDAV fixture",
        description: null,
        source: { kind: "desktop-loopback" },
        destination: {
          ...destination,
          ...binding,
          workerId,
          resourceId: tunnelId,
        },
        dataProtection,
      };
      const protectedRecord = {
        operationId: tunnelId,
        revision: 1,
        protectedContent: await crypto.encryptEndpointContentPayload({
          ownerId,
          componentKey,
          keyRevision,
          context: {
            domain: component,
            serverId,
            workerId,
            scopeId: JSON.stringify(["tunnel", tunnelId]),
            operationId: tunnelId,
            sequence: 1,
            operation: "tunnel.record",
            direction: "stored",
          },
          plaintext: Buffer.from(JSON.stringify(record)),
        }),
      };
      return {
        ...binding,
        dataProtection,
        input: { workerId, tunnelId, protectedRecord },
      };
    };
    const projectShare = await makeShare({
      kind: "worker-project-share",
      root: checkout,
    });
    const project = `/api/projects/${projectId}/network-shares`;
    const missing = await makeShare({
      kind: "worker-project-share",
      root: path.join(checkout, "absent-share-root"),
    });
    assert.equal(
      (await request("POST", project, 409, missing.input)).code,
      "project-source-unavailable",
    );
    await exerciseShare(project, checkout, projectShare, "worker-link");

    const chatId = randomUUID();
    await request("POST", "/api/chats", 202, {
      id: chatId,
      autoTitle: false,
      titleProtection: await crypto.encryptPrivateDisplayLabel({
        ownerId,
        keyRevision,
        recordKind: "chat",
        rowId: chatId,
        componentKey: labels,
        label: "Native scratch share fixture",
      }),
    });
    const scratch = await eventually(
      async () => {
        const value = JSON.parse(
          await readFile(
            path.join(workerDirectory, "chat-scratch-registry.json"),
            "utf8",
          ),
        );
        return value.roots.find((root) => root.chatId === chatId);
      },
      (root) => assert.ok(root?.rootId),
      "worker provisions a real standalone Chat scratch root",
    );
    const chat = `/api/chats/${chatId}/network-shares`;
    const mismatched = await makeShare({
      kind: "worker-chat-share",
      chatId,
      rootId: randomUUID(),
    });
    assert.equal(
      (await request("POST", chat, 502, mismatched.input)).code,
      "worker-share-open-failed",
    );
    const share = await makeShare({
      kind: "worker-chat-share",
      chatId,
      rootId: scratch.rootId,
    });
    await exerciseShare(
      chat,
      path.join(workerDirectory, "chat-scratch", chatId),
      share,
      "legacy",
    );
  } finally {
    componentKey.fill(0);
    labels.fill(0);
  }

  async function exerciseShare(route, root, share, carrier) {
    const mount = await request("POST", route, 201, share.input);
    assert.equal(mount.protocol, "webdav");
    assert.ok(!JSON.stringify(mount).includes(root));
    assert.ok(!JSON.stringify(mount).includes(share.password));
    let connection;
    let deleted = false;
    try {
      connection = await attach(
        request,
        origin,
        workerId,
        mount.tunnelId,
        carrier,
      );
      const run = (method, suffix, body, headers) =>
        webdav(connection.open, share, method, suffix, body, headers);
      const proof = "private-native-webdav-" + randomUUID();
      const name = "/remote-work.txt";
      const denied = await webdav(
        connection.open,
        { ...share, password: "invalid" },
        "GET",
        name,
      );
      assert.equal(denied.status, 401);
      assert.equal(
        (await run("PUT", name, proof, { If: "(<DAV:no-lock>)" })).status,
        201,
      );
      assert.equal(
        await readFile(path.join(root, name.slice(1)), "utf8"),
        proof,
      );
      assert.equal((await run("GET", name)).body.toString(), proof);
      const listing = await run("PROPFIND", "/", "", { Depth: "1" });
      assert.equal(listing.status, 207);
      assert.match(listing.body.toString(), /remote-work\.txt/);
      assert.equal(
        (
          await run("PUT", "/rejected.txt", "discard", {
            If: "(Not <DAV:no-lock>)",
          })
        ).status,
        412,
      );
      assert.equal((await run("PUT", "/.DS_Store", "discard")).status, 403);
      const rejected = await run("MOVE", name, "", {
        Destination: share.publicOrigin + share.publicBasePath + "/._temp",
      });
      assert.equal(rejected.status, 403);
      if (carrier === "worker-link") {
        const attachment = await request(
          "POST",
          `/api/tunnels/${mount.tunnelId}/attachments`,
          201,
          { clientId: randomUUID() },
        );
        const direct = await openDirectTunnel(request, attachment.attachmentId);
        try {
          const reply = await webdav(
            () => direct.open(credit),
            share,
            "GET",
            name,
          );
          assert.equal(reply.status, 200);
          assert.equal(reply.body.toString(), proof);
          await direct.revoke();
        } finally {
          direct.socket.terminate();
        }
        await verifyLocksAndProperties(run, name);
        const publicPath = share.publicOrigin + share.publicBasePath;
        assert.equal((await run("MKCOL", "/folder")).status, 201);
        assert.equal(
          (
            await run("COPY", name, "", {
              Destination: publicPath + "/folder/copy.txt",
            })
          ).status,
          201,
        );
        assert.equal(
          (
            await run("MOVE", "/folder", "", {
              Destination: publicPath + "/moved",
            })
          ).status,
          201,
        );
        assert.equal(
          (await run("GET", "/moved/copy.txt")).body.toString(),
          proof,
        );
        await writeFile(
          path.join(root, "moved", ".DS_Store"),
          "existing metadata",
        );
        assert.equal((await run("DELETE", "/moved")).status, 204);
        const outside = path.join(workerDirectory, "outside-share.txt");
        await writeFile(outside, "outside fixture marker");
        await symlink(outside, path.join(root, "outside-link"));
        assert.equal((await run("GET", "/outside-link")).status, 403);
      }
      const closed = once(connection.socket, "close", {
        signal: AbortSignal.timeout(7000),
      });
      await request("DELETE", "/api/project-shares/" + mount.attachmentId, 204);
      if (carrier === "worker-link") {
        // The relay carrier can stay open after its logical grant is revoked.
        assert.equal((await connection.nextClose()).code, "revoked");
        connection.socket.close();
      }
      await closed;
      deleted = true;
      assert.equal(
        await readFile(path.join(root, name.slice(1)), "utf8"),
        proof,
      );
    } finally {
      connection?.socket.terminate();
      await connection?.dispose?.();
      if (!deleted)
        await call("DELETE", "/api/project-shares/" + mount.attachmentId);
    }
  }
}

async function verifyLocksAndProperties(run, name) {
  const lock = await run(
    "LOCK",
    name,
    '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
    { Depth: "0", "Content-Type": "application/xml", Timeout: "Second-60" },
  );
  assert.equal(lock.status, 200);
  assert.ok(lock.headers["lock-token"]);
  assert.equal((await run("PUT", name, "blocked")).status, 423);
  assert.equal(
    (
      await run("UNLOCK", name, "", {
        "Lock-Token": lock.headers["lock-token"],
      })
    ).status,
    204,
  );
  const patched = await run(
    "PROPPATCH",
    name,
    '<D:propertyupdate xmlns:D="DAV:" xmlns:T="urn:cantrip:fixture"><D:set><D:prop><T:proof>stored-value</T:proof></D:prop></D:set></D:propertyupdate>',
    { "Content-Type": "application/xml" },
  );
  assert.equal(patched.status, 207);
  const listed = await run("PROPFIND", name, "", { Depth: "0" });
  assert.match(listed.body.toString(), /stored-value/);
}

async function attach(call, origin, workerId, tunnelId, carrier) {
  const clientId = randomUUID();
  const attachment = await call(
    "POST",
    `/api/tunnels/${tunnelId}/attachments`,
    201,
    { clientId },
  );
  if (carrier === "legacy") {
    const legacy = await openLegacyTunnel({
      origin,
      attachment,
      clientId,
      tunnelId,
      workerId,
    });
    return {
      socket: legacy.socket,
      open: () => legacy.open(undefined, credit),
    };
  }
  let session = await call(
    "POST",
    `/api/workers/${workerId}/worker-link/sessions`,
    201,
    { clientInstanceId: clientId },
  );
  const base = "/api/worker-links/" + session.sessionId;
  if (session.preferredRoute !== "relay")
    session = await call("POST", base + "/route", 200, {
      preferredRoute: "relay",
    });
  const { grant, route } = workerLinkTunnelGrantSchema.parse(
    await call(
      "POST",
      base + "/tunnel-attachments/" + attachment.attachmentId + "/grant",
      201,
      {},
    ),
  );
  const url = new URL(base + "/connect", origin);
  url.protocol = "ws:";
  url.searchParams.set("clientInstanceId", clientId);
  url.searchParams.set("routeGeneration", String(session.routeGeneration));
  const connection = new Connection(url, session);
  try {
    await connection.open(grant, credit);
    return {
      socket: connection.socket,
      open: () => connection.stream(route, undefined, credit),
      nextClose: () => connection.nextControl("close"),
      dispose: () => call("DELETE", base, 204),
    };
  } catch (error) {
    connection.socket.terminate();
    await call("DELETE", base, 204);
    throw error;
  }
}

async function webdav(open, share, method, suffix, body = "", extra = {}) {
  const uri = share.publicBasePath + suffix;
  const send = async (authorization) => {
    const header = [
      `${method} ${uri} HTTP/1.1`,
      "Host: 127.0.0.1",
      "Connection: close",
      `Content-Length: ${Buffer.byteLength(body)}`,
      ...Object.entries(extra).map(([key, value]) => `${key}: ${value}`),
    ];
    if (authorization) header.push("Authorization: " + authorization);
    const stream = open();
    const accepted = await stream.next("accepted", "rejected");
    assert.equal(
      accepted.header.kind,
      "accepted",
      JSON.stringify(accepted.header),
    );
    stream.send(
      { kind: "data", direction: "source-to-destination" },
      Buffer.from(header.join("\r\n") + "\r\n\r\n" + body),
      share.dataProtection,
    );
    const chunks = [];
    for (;;) {
      const frame = await stream.next("data", "half-close");
      if (frame.header.kind === "half-close") break;
      assert.ok(frame.header.protection);
      chunks.push(
        openTunnelDataFrame(share.dataProtection, frame.header, frame.payload),
      );
    }
    stream.send({ kind: "close", code: "normal" });
    return parseWebdavResponse(Buffer.concat(chunks));
  };
  const challenge = await send(null);
  assert.equal(challenge.status, 401);
  const fields = Object.fromEntries(
    [
      ...challenge.headers["www-authenticate"].matchAll(/([a-z]+)="([^"]*)"/g),
    ].map((match) => [match[1], match[2]]),
  );
  assert.equal(fields.realm, share.realm);
  assert.equal(fields.qop, "auth");
  const md5 = (text) => createHash("md5").update(text).digest("hex");
  const nc = "00000001";
  const cnonce = randomUUID();
  const digest = md5(
    `${md5(`${share.username}:${fields.realm}:${share.password}`)}:${fields.nonce}:${nc}:${cnonce}:auth:${md5(`${method}:${uri}`)}`,
  );
  return send(
    `Digest username="${share.username}", realm="${fields.realm}", nonce="${fields.nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${digest}", opaque="${fields.opaque}"`,
  );
}
