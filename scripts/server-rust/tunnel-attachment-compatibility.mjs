// Production HTTP/WS and the existing worker transport on isolated databases.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { AttachmentFixture } from "./tunnel-attachment-fixture.mjs";
import { tunnelAttachmentCases } from "./tunnel-attachment-cases.mjs";
import { tunnelAttachmentLocks } from "./tunnel-attachment-locks.mjs";
import { tunnelRuntimeFaults } from "./tunnel-runtime-faults.mjs";
import { tunnelRuntimeShutdown } from "./tunnel-runtime-shutdown.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
} from "./project-target-state.mjs";
import { tunnelStateSql } from "./tunnel-state.mjs";
import { password, heartbeat } from "./security-fixtures.mjs";
import { directAttachmentWireFixtures } from "./direct-attachment-wire-fixtures.mjs";
import { terminalGrantWorker } from "./terminal-worker-link-cases.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { until } from "./tunnel-attachment-probe.mjs";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
const option = (key) => {
  const at = process.argv.indexOf(key);
  return at < 0 ? undefined : process.argv[at + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const faults = process.argv.includes("--runtime-faults"),
  shutdown = process.argv.includes("--runtime-shutdown");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-tunnel-attachment-"));
const report = {
  suite: shutdown
    ? "actual-tunnel-runtime-shutdown"
    : faults
      ? "actual-tunnel-runtime-faults"
      : "actual-tunnel-attachment-http-ws",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
let pg, failure;
try {
  const executable = await buildRustServer(),
    repositoryBinary = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "accounts"]) {
    const runtimes = [];
    report.profiles.push({ profile, runtimes });
    for (const kind of ["node", "rust"]) {
      const databaseUrl =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const fixture = new AttachmentFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
          ...(kind === "rust" && databaseMode === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const result = { kind, observations: [], commands: [], connections: 0 };
      runtimes.push(result);
      let repo, worker, live;
      const openRepo = () =>
        repositoryFixture({
          kind,
          executable: repositoryBinary,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl,
        });
      const visit = async (label, method, url, options = {}) => {
        const observation = await fixture.observe(label, method, url, {
          csrf:
            !["GET", "HEAD"].includes(method) &&
            !!fixture.client(options.client).csrf,
          ...options,
        });
        result.observations.push({ label, ...observation });
        return fixture.records.get(label);
      };
      try {
        await fixture.start();
        let owner = localOwner,
          other = otherOwner;
        if (profile === "accounts") {
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              status: 201,
              json: {
                email: `tunnel-attachment-${client}@example.invalid`,
                displayName: client,
                password,
              },
            });
          owner = fixture.records.get("register main").currentUser.id;
          other = fixture.records.get("register other").currentUser.id;
        } else await visit("session", "GET", "/api/auth/session");
        await fixture.close();
        repo = await openRepo();
        for (const sql of [
          ...targetStateSql(owner, other),
          ...tunnelStateSql(owner, other),
        ])
          await repo.seed(sql);
        await repo.close();
        repo = undefined;
        await fixture.start();
        await visit(
          "enrollment code",
          "POST",
          "/api/workers/enrollment-codes",
          { json: {}, status: 201 },
        );
        await visit("enrolled worker", "POST", "/api/internal/workers/enroll", {
          client: "worker",
          json: {
            code: fixture.records.get("enrollment code").code,
            heartbeat: {
              ...heartbeat,
              workerId: "alpha",
              directBroker:
                directAttachmentWireFixtures.directAttachmentTicketSchema[0]
                  .broker,
            },
          },
          status: 201,
        });
        const bootstrap = await visit("bootstrap", "GET", "/api/bootstrap");
        const control = terminalGrantWorker({
          serverId: bootstrap.server.id,
          owner,
          commands: result.commands,
        });
        control.frames = [];
        const config = {
          dataDirectory: path.join(root, profile, kind, "worker"),
          name: "Tunnel transport",
          serverUrl: fixture.server.origin,
          enrollmentCode: null,
          replacement: null,
          token: fixture.records.get("enrolled worker").credential,
          tokenSource: "persisted",
          workerId: "alpha",
        };
        saveWorkerCredential({
          credential: config.token,
          dataDirectory: config.dataDirectory,
          serverUrl: config.serverUrl,
          workerId: config.workerId,
        });
        worker = new WorkerConnection(
          config,
          async (command, emit) => {
            result.commands.push(command);
            if (
              [
                "terminal.services.reconcile",
                "project.run-configuration-runtime.reconcile",
              ].includes(command.type)
            )
              return { notAResponseSchema: true };
            return await control.handle(command, emit);
          },
          undefined,
          (header, payload) => {
            control.frames.push({
              header,
              payload: Buffer.from(payload).toString("base64"),
            });
            if (header.kind === "connect") {
              const { target, diagnosticTraceId, ...base } = header;
              worker.sendTunnelDataPlaneFrame(
                { ...base, kind: "accepted", initialCreditBytes: 1024 },
                new Uint8Array(),
              );
            } else if (header.kind === "data" || header.kind === "half-close")
              worker.sendTunnelDataPlaneFrame(
                { ...header, direction: "destination-to-source" },
                payload,
              );
          },
          undefined,
          1000,
          () => result.connections++,
        );
        worker.start();
        await until(
          () => result.connections === 1,
          "actual tunnel worker ready",
        );
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed("tunnel-attachments", [
          { kind: "current-user" },
          { kind: "project", projectId: "github" },
        ]);
        if (shutdown)
          await tunnelRuntimeShutdown({
            fixture,
            visit,
            result,
            authorization: process.argv.includes("--pending-authorization"),
          });
        else if (faults)
          await tunnelRuntimeFaults({
            fixture,
            visit,
            result,
            databaseMode,
            worker,
          });
        else
          await tunnelAttachmentCases({
            fixture,
            visit,
            profile,
            result,
            live,
            control,
            worker,
          });
        if (
          !faults &&
          !shutdown &&
          databaseMode === "postgres" &&
          profile === "none"
        )
          await tunnelAttachmentLocks({ fixture, visit, result });
        result.normalizedCommands = fixture.normalize(
          result.commands.filter((command) =>
            command.type.startsWith("direct.capability."),
          ),
        );
        worker.close();
        await live.close();
        live = undefined;
        await fixture.close();
        repo = await openRepo();
        const state = await repo.request({
          op: "query-json",
          sql: "SELECT jsonb_build_object('tunnels',(SELECT jsonb_agg(jsonb_build_object('id',id,'desiredState',desired_state,'status',status,'errorCode',error_code,'activeConnectionCount',active_connection_count) ORDER BY id) FROM tunnels),'attachments',(SELECT jsonb_agg(jsonb_build_object('id',id,'tunnelId',tunnel_id,'clientId',client_id,'status',status,'errorCode',error_code,'hash',secret_hash,'hasSecretExpiry',secret_expires_at IS NOT NULL,'hasLastSeen',last_seen_at IS NOT NULL,'activeConnectionCount',active_connection_count) ORDER BY id) FROM tunnel_attachments),'leases',(SELECT jsonb_agg(jsonb_build_object('attachmentId',attachment_id,'capabilityId',capability_id,'status',status) ORDER BY capability_id) FROM tunnel_attachment_direct_leases)) result",
        });
        assert.equal(state.rejected, false);
        result.state = fixture.normalize(state.value);
        result.rawState = state.value;
        const bandwidth = await repo.request({
          op: "query-json",
          sql: "SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) result FROM (SELECT channel,direction,sum(bytes)::text bytes,sum(operation_count)::text operations FROM account_bandwidth_usage_buckets WHERE resolution='hour' AND channel IN ('tunnel-relay','project-share-relay') GROUP BY channel,direction ORDER BY channel,direction) r",
        });
        assert.equal(bandwidth.rejected, false);
        result.bandwidth = bandwidth.value;
        assert.deepEqual(
          result.bandwidth.map((row) => row.direction),
          ["egress", "ingress"],
        );
        assert.ok(
          result.bandwidth.every(
            (row) => BigInt(row.bytes) > 0n && BigInt(row.operations) > 0n,
          ),
        );
        // Generated UUIDs change their SQL sort positions between isolated
        // servers. Compare the same rows by stable client identity after
        // retaining the actual ordered query output above.
        result.state.attachments.sort((a, b) =>
          a.clientId.localeCompare(b.clientId),
        );
        await repo.close();
        repo = undefined;
      } catch (error) {
        result.error = {
          message: error.message,
          stack: error.stack,
          diagnostics: fixture.server?.diagnostics(),
        };
        throw error;
      } finally {
        worker?.close();
        await live?.close();
        await fixture.close();
        await repo?.close();
      }
    }
    for (const key of [
      "observations",
      "sockets",
      "readiness",
      "workerFrames",
      "tunnelEvents",
      "normalizedCommands",
      "state",
      "activationLocks",
      "heartbeat",
      "bandwidth",
      "attachmentGrantIsolation",
      "runtimeFaults",
      "runtimeShutdown",
    ])
      assert.deepEqual(
        runtimes[1][key],
        runtimes[0][key],
        profile + " actual " + key,
      );
  }
} catch (error) {
  failure = error;
  report.error = { message: error.message, stack: error.stack };
} finally {
  await pg?.close();
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (failure) console.error("Retained failed attachment fixture:", root);
  else await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    databaseMode,
    profiles: report.profiles.map(({ profile, runtimes }) => ({
      profile,
      runtimes: runtimes.map(({ kind, observations, sockets }) => ({
        kind,
        observations: observations.length,
        sockets: sockets?.length,
      })),
    })),
  }),
);
