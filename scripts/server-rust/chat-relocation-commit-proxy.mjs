// Transparent loopback PostgreSQL fault injection. Hold the real placement
// COMMIT acknowledgement, then close that connection after the backend commits.
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { createRequire } from "node:module";
const postgres = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("postgres");

export async function relocationFaultRuntime(connection, kind, profile) {
  const upstream = new URL(connection),
    admin = postgres(connection, { max: 1 });
  const role = `relocation_subject_${kind}_${profile}`;
  let wire;
  try {
    await admin`CREATE ROLE ${admin(role)} LOGIN PASSWORD 'isolated-local-role-password'`;
    await admin`ALTER DATABASE ${admin(decodeURIComponent(upstream.pathname.slice(1)))} OWNER TO ${admin(role)}`;
    upstream.username = role;
    upstream.password = "isolated-local-role-password";
    wire = await commitProxy(upstream.href);
    return {
      ...wire,
      role,
      admin,
      async denyJobRead() {
        await admin`REVOKE SELECT ON chat_relocation_jobs FROM ${admin(role)}`;
      },
      async restoreJobRead() {
        await admin`GRANT SELECT ON chat_relocation_jobs TO ${admin(role)}`;
      },
      async close() {
        try {
          await wire.close();
        } finally {
          await admin.end({ timeout: 5 });
        }
      },
    };
  } catch (error) {
    await wire?.close();
    await admin.end({ timeout: 5 });
    throw error;
  }
}

async function commitProxy(connection) {
  const target = new URL(connection),
    peers = new Set(),
    observations = [];
  let gate;
  const server = net.createServer((client) => {
    const remote = net.connect(Number(target.port || 5432), target.hostname);
    const peer = { client, remote, holding: false, held: [] };
    peers.add(peer);
    client.setNoDelay(true);
    remote.setNoDelay(true);
    let frontend = Buffer.alloc(0),
      backend = Buffer.alloc(0),
      startup = true,
      sslResponse = false;
    const statements = new Map();
    const inspect = (query) => {
      const normalized = query.replaceAll('"', "").trim();
      if (
        gate &&
        /^update\s+chats\s+set\b/i.test(normalized) &&
        /\bplacement_revision\b/i.test(normalized)
      ) {
        peer.placementWrite = gate;
        observations.push({
          boundary: "placement-update-sent",
          backendPid: peer.backendPid,
          query,
        });
      }
      if (
        gate &&
        peer.placementWrite === gate &&
        /^commit\s*;?$/i.test(normalized)
      ) {
        assert.equal(
          gate.commitPeer,
          undefined,
          "One actual placement commit reaches the fault boundary",
        );
        gate.commitPeer = peer;
        peer.holding = true;
        observations.push({
          boundary: "placement-commit-sent",
          backendPid: peer.backendPid,
        });
      }
      const where = normalized
        .split(/\bwhere\b/i)
        .slice(1)
        .join("where");
      if (
        gate?.dropped &&
        /^select\b/i.test(normalized) &&
        /\bchat_relocation_jobs\b/i.test(normalized) &&
        /\bowner_id\b/i.test(where) &&
        /\bid\b/i.test(where)
      )
        peer.recoveryRead = gate;
      if (
        gate?.dropped &&
        /^select\b/i.test(normalized) &&
        /\bchat_relocation_jobs\b/i.test(normalized) &&
        /\bcommand_id\b/i.test(where) &&
        /\battempt\b/i.test(where)
      )
        peer.settlementRead = gate;
    };
    client.on("data", (bytes) => {
      frontend = Buffer.concat([frontend, bytes]);
      while (frontend.length >= (startup ? 8 : 5)) {
        const length = frontend.readUInt32BE(startup ? 0 : 1),
          total = length + (startup ? 0 : 1);
        assert.ok(length >= 4 && length < 256 * 1024 * 1024);
        if (frontend.length < total) break;
        const frame = frontend.subarray(0, total);
        frontend = frontend.subarray(total);
        if (startup) {
          if (length === 8 && frame.readUInt32BE(4) === 80877103)
            sslResponse = true;
          else startup = false;
        } else if (frame[0] === 81) inspect(frame.subarray(5, -1).toString());
        else if (frame[0] === 80) {
          const end = frame.indexOf(0, 5),
            start = end + 1;
          statements.set(
            frame.subarray(5, end).toString(),
            frame.subarray(start, frame.indexOf(0, start)).toString(),
          );
        } else if (frame[0] === 66) {
          const start = frame.indexOf(0, 5) + 1;
          inspect(
            statements.get(
              frame.subarray(start, frame.indexOf(0, start)).toString(),
            ) ?? "",
          );
        }
      }
      remote.write(bytes);
    });
    remote.on("data", (bytes) => {
      backend = Buffer.concat([backend, bytes]);
      if (sslResponse && backend.length) {
        assert.equal(
          backend[0],
          78,
          "Disposable fixture negotiates plaintext PostgreSQL",
        );
        client.write(backend.subarray(0, 1));
        backend = backend.subarray(1);
        sslResponse = false;
      }
      while (backend.length >= 5) {
        const total = backend.readUInt32BE(1) + 1;
        if (backend.length < total) break;
        const frame = backend.subarray(0, total);
        backend = backend.subarray(total);
        if (frame[0] === 75) peer.backendPid = frame.readInt32BE(5);
        if (
          gate?.commitPeer === peer &&
          frame[0] === 67 &&
          frame.subarray(5).equals(Buffer.from("COMMIT\0"))
        ) {
          assert.ok(Number.isInteger(peer.backendPid));
          gate.committed = {
            actualCommandComplete: "COMMIT",
            backendPid: peer.backendPid,
          };
          observations.push({
            boundary: "actual-placement-commit-complete",
            ...gate.committed,
          });
        }
        if (gate?.dropped && frame[0] === 69) {
          const fields = {};
          let cursor = 5;
          while (frame[cursor]) {
            const key = String.fromCharCode(frame[cursor++]),
              end = frame.indexOf(0, cursor);
            fields[key] = frame.subarray(cursor, end).toString();
            cursor = end + 1;
          }
          if (
            peer.recoveryRead === gate &&
            fields.C === "42501" &&
            fields.M.includes("chat_relocation_jobs")
          ) {
            gate.readDenied = {
              sqlstate: fields.C,
              message: fields.M,
              queryKind: "owner-scoped-relocation-reread",
            };
            observations.push({
              boundary: "actual-job-read-denied",
              ...gate.readDenied,
            });
            peer.recoveryRead = undefined;
          }
        }
        if (frame[0] === 67) peer.recoveryRead = undefined;
        if (gate?.dropped && peer.settlementRead === gate && frame[0] === 67) {
          gate.settlementReadCompleted = true;
          observations.push({
            boundary: "actual-fenced-settlement-read-complete",
            tag: frame.subarray(5, -1).toString(),
          });
          peer.settlementRead = undefined;
        }
        if (peer.holding) peer.held.push(Buffer.from(frame));
        else client.write(frame);
      }
    });
    const close = () => {
      peers.delete(peer);
      client.destroy();
      remote.destroy();
    };
    for (const socket of [client, remote]) {
      socket.on("error", close);
      socket.on("close", close);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const exposed = new URL(connection);
  exposed.hostname = "127.0.0.1";
  exposed.port = String(server.address().port);
  exposed.searchParams.set("sslmode", "disable");
  return {
    url: exposed.href,
    observations,
    arm() {
      assert.equal(gate, undefined);
      const current = {};
      gate = current;
      return {
        get committed() {
          return current.committed;
        },
        get readDenied() {
          return current.readDenied;
        },
        get settlementReadCompleted() {
          return current.settlementReadCompleted;
        },
        dropAcknowledgement() {
          assert.ok(
            current.committed,
            "Drop follows actual backend COMMIT, not inferred success",
          );
          current.dropped = true;
          current.commitPeer.client.destroy();
          current.commitPeer.remote.destroy();
        },
        disarm() {
          assert.equal(gate, current);
          gate = undefined;
        },
      };
    },
    async close() {
      for (const peer of peers) {
        peer.client.destroy();
        peer.remote.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
