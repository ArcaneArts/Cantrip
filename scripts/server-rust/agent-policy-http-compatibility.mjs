// Actual MCP HTTP, worker authentication, encrypted policies and audit behavior.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import { assets } from "./policy-assets.mjs";
import {
  seedPolicies,
  policyIds,
  privateMarker,
} from "./agent-policy-http-fixtures.mjs";
import { literal, json, label } from "./project-target-state.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsProject as project,
  settingsWorker as worker,
  settingsTree as tree,
} from "./native-settings-http-fixture.mjs";

const option = (key) => {
  const index = process.argv.indexOf(key);
  return index < 0 ? undefined : process.argv[index + 1];
};
const databaseMode = option("--database") ?? "pglite";
const peers = option("--peer") ? [option("--peer")] : ["node", "rust"];
const reportPath =
  option("--report") ?? `.qa/rust-server/mcp-policy-${databaseMode}.json`;
const queries = JSON.parse(
  await readFile(
    new URL(
      "../../cantrip_server_rs/contracts/mcp-policy-queries.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-mcp-policy-"));
const report = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  root,
  databaseMode,
  actualHttp: true,
  actualWorkerConnection: true,
  fullWorkerProcess: false,
  completeReplacement: false,
  profiles: [],
};
let h, postgres, failure;
try {
  const executable = peers.includes("rust")
    ? (process.env.CANTRIP_RUST_SERVER_BINARY ??
      (await buildRustExample("http-sql-fixture")))
    : undefined;
  report.executable = executable;
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    postgres = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (value) => !option("--profile") || value === option("--profile"),
  )) {
    const p = { profile, peers: [], differences: [] };
    report.profiles.push(p);
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 120000).toISOString();
    for (const kind of peers) {
      const result = { kind, observations: [], commands: [], calls: [] };
      p.peers.push(result);
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        databaseMode,
        passwordHash,
        result,
        liveSqlFixture: true,
        url:
          postgres && (kind === "node" || databaseMode === "postgres")
            ? await postgres.database()
            : undefined,
        onCommand: async (command) => {
          result.commands.push({ type: command.type });
        },
      });
      try {
        await h.fixture.sql([
          `UPDATE chats SET status='running',permission_profile_id=':workspace' WHERE id=${literal(chat)}`,
          `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('mcp-policy-lane',${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'Qualification','active',now(),'settings-runtime')`,
        ]);
        const policies = await seedPolicies(h);
        const binding = {
          bindingId: "eeeeeeee-eeee-4eee-8eee-000000000500",
          ownerId: h.owner,
          contextKind: "project",
          projectId: project,
          chatId: chat,
          executionLaneId: "mcp-policy-lane",
          workerId: worker,
          worktreeId: tree,
          rootKind: "git-worktree",
          scratchRootId: null,
          permissionProfileId: ":workspace",
          allowedOperations: [
            "context.get",
            "context.compact",
            "policy.list",
            "policy.read",
          ],
          issuedAt,
          expiresAt,
        };
        function comparison(body) {
          const value = policies.comparison(body);
          function workspaceIds(value) {
            if (Array.isArray(value)) return value.map(workspaceIds);
            if (value && typeof value === "object")
              return Object.fromEntries(
                Object.entries(value).map(([key, item]) => {
                  if (key === "workspaceId") {
                    assert.equal(item, policies.workspace);
                    return [key, "<verified owned workspace>"];
                  }
                  return [key, workspaceIds(item)];
                }),
              );
            return value;
          }
          return workspaceIds(value);
        }
        async function call(
          name,
          operation,
          args = {},
          status = 200,
          claims = binding,
        ) {
          const response = await fetch(
            h.fixture.server.origin + "/api/internal/agent-operations",
            {
              method: "POST",
              headers: {
                authorization: "Bearer " + h.credential,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                requestId: randomUUID(),
                binding: claims,
                request: { operation, arguments: args },
              }),
              signal: AbortSignal.timeout(15000),
            },
          );
          const body = await response.json();
          result.calls.push({
            name,
            operation,
            args,
            status: response.status,
            body,
            httpRequestId: response.headers.get("x-request-id"),
          });
          assert.equal(
            response.status,
            status,
            JSON.stringify({ kind, name, body }),
          );
          return body;
        }
        let decryptedPolicyReads = 0;
        async function read(name, id, args = {}) {
          const result = await call(name, "policy.read", {
            ...args,
            policyId: id,
          });
          await policies.verifyRead(result.data, id.trim());
          decryptedPolicyReads++;
          return result;
        }
        const caps = await fetch(
          h.fixture.server.origin +
            "/api/internal/agent-operations/capabilities?workerId=" +
            worker,
          {
            headers: { authorization: "Bearer " + h.credential },
            signal: AbortSignal.timeout(15000),
          },
        );
        assert.equal(caps.status, 200);
        result.capabilities = await caps.json();
        for (const operation of [
          "context.compact",
          "policy.list",
          "policy.read",
        ])
          assert.ok(result.capabilities.operations.includes(operation));
        const readiness = await call(
          "compaction grant makes current-turn MCP mutations ready",
          "context.get",
        );
        assert.equal(readiness.data.binding.status, "ready");
        assert.equal(readiness.data.binding.mutationReady, true);
        const listed = await call(
          "effective policies retain order and assignment provenance",
          "policy.list",
        );
        assert.deepEqual(
          listed.data.policies.map((policy) => policy.id),
          [policyIds.workspace, policyIds.direct, policyIds.mandatory],
        );
        assert.deepEqual(listed.data.policies[0].sources, [
          { type: "workspace", workspaceId: policies.workspace },
          { type: "project", projectId: project },
        ]);
        assert.deepEqual(listed.data.policies[2].sources, [
          { type: "mandatory" },
        ]);
        for (const policy of listed.data.policies)
          assert.deepEqual(
            policy.protectedSummary,
            policies.get(policy.id).content.protectedSummary,
          );
        assert.deepEqual(
          (
            await call("list ignores operation arguments", "policy.list", {
              unknown: true,
            })
          ).data,
          listed.data,
        );
        const original = await read(
          "encrypted assigned policy body",
          policyIds.workspace,
        );
        assert.equal(original.data.policy.workspaceAssignmentCount, 1);
        assert.equal(original.data.policy.projectAssignmentCount, 1);
        await read(
          "required policy identity follows JavaScript whitespace trimming",
          "\ufeff \n" + policyIds.workspace + "\t\ufeff",
          { unknown: true },
        );
        for (const [name, id] of Object.entries(policyIds).filter(([name]) =>
          ["disabled", "chatOnly", "unassigned", "foreign"].includes(name),
        )) {
          assert.deepEqual(
            await call(
              name + " policy remains outside effective project scope",
              "policy.read",
              { policyId: id },
              404,
            ),
            {
              code: "not-found",
              error: "That policy is not effective for the current project.",
            },
          );
        }
        for (const value of [
          undefined,
          null,
          false,
          42,
          [],
          {},
          "",
          "\ufeff \t",
        ]) {
          assert.deepEqual(
            await call(
              "invalid required policy string " + JSON.stringify(value),
              "policy.read",
              value === undefined ? {} : { policyId: value },
              400,
            ),
            { code: "invalid", error: "policyId is required." },
          );
        }
        await call(
          "unpaired UTF-16 identity does not match a stored ID",
          "policy.read",
          { policyId: "\ud800" },
          404,
        );
        await call(
          "safe read binding survives lane and permission transitions",
          "policy.list",
          {},
          200,
          {
            ...binding,
            executionLaneId: "old-policy-lane",
            permissionProfileId: ":read-only",
          },
        );
        assert.deepEqual(
          await call(
            "compaction authorization retains defaulted result",
            "context.compact",
          ),
          {
            summary: "Current-turn context compaction is authorized.",
            mutated: true,
            continuationScheduled: false,
            target: null,
            worktreeId: tree,
          },
        );
        await call(
          "compaction ignores operation arguments",
          "context.compact",
          { unknown: true },
        );
        await call(
          "compaction requires exact mutation lane",
          "context.compact",
          {},
          409,
          { ...binding, executionLaneId: "old-policy-lane" },
        );
        await call(
          "policy grant remains binding scoped",
          "policy.list",
          {},
          403,
          { ...binding, allowedOperations: ["context.get"] },
        );
        await call(
          "foreign binding owner cannot read policy metadata",
          "policy.list",
          {},
          403,
          { ...binding, ownerId: "mcp-foreign-policy-owner" },
        );
        await h.fixture.sql([
          `UPDATE chats SET permission_profile_id=':read-only' WHERE id=${literal(chat)}`,
        ]);
        await call(
          "read-only attachment reads effective policies",
          "policy.list",
          {},
          200,
          { ...binding, permissionProfileId: ":read-only" },
        );
        await call(
          "read-only attachment cannot compact",
          "context.compact",
          {},
          403,
          { ...binding, permissionProfileId: ":read-only" },
        );
        await h.fixture.sql([
          `UPDATE chats SET permission_profile_id=':workspace',status='idle' WHERE id=${literal(chat)}`,
        ]);
        await call(
          "policy reads require an active chat",
          "policy.list",
          {},
          409,
        );
        await h.fixture.sql([
          `UPDATE chats SET status='running' WHERE id=${literal(chat)}`,
          `UPDATE policies SET protected_body='{}'::jsonb WHERE id=${literal(policyIds.workspace)}`,
        ]);
        await call(
          "opaque list does not validate unused body content",
          "policy.list",
        );
        assert.deepEqual(
          await call(
            "invalid stored policy body uses generic MCP validation failure",
            "policy.read",
            { policyId: policyIds.workspace },
            400,
          ),
          {
            code: "invalid",
            error: "Cantrip MCP operation validation failed on the server.",
          },
        );
        await h.fixture.sql([
          `UPDATE policies SET protected_body=${json(policies.get(policyIds.workspace).content.protectedBody)} WHERE id=${literal(policyIds.workspace)}`,
          `UPDATE policies SET protected_summary='{}'::jsonb WHERE id=${literal(policyIds.unassigned)}`,
        ]);
        await call(
          "invalid ineffective policy summary is not exposed",
          "policy.list",
        );
        await h.fixture.sql([
          `UPDATE policies SET protected_summary='{}'::jsonb WHERE id=${literal(policyIds.workspace)}`,
        ]);
        assert.deepEqual(
          await call(
            "invalid effective policy summary uses generic MCP validation failure",
            "policy.list",
            {},
            400,
          ),
          {
            code: "invalid",
            error: "Cantrip MCP operation validation failed on the server.",
          },
        );
        await h.fixture.sql([
          `UPDATE policies SET protected_summary=${json(policies.get(policyIds.workspace).content.protectedSummary)} WHERE id=${literal(policyIds.workspace)}`,
        ]);

        async function queryFailure(
          name,
          key,
          params,
          operation = "policy.list",
          args = {},
        ) {
          const body = await call(name, operation, args, 400);
          assert.deepEqual(
            body,
            {
              code: "invalid",
              error: (
                "Failed query: " +
                queries[key] +
                "\nparams: " +
                params.join(",")
              ).slice(0, 2000),
            },
            "The real database failure retains exact Source SQL and actual request-bound parameters",
          );
          Object.assign(result.calls.at(-1), {
            verifiedQueryFailure: { key, sql: queries[key], params },
            comparisonBody: {
              code: "invalid",
              error: `<verified exact Source ${key} query and actual peer parameters>`,
            },
          });
        }
        await h.fixture.sql([
          "CREATE FUNCTION mcp_policy_ensure_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'actual MCP policy ensure failure'; END $$",
          "CREATE TRIGGER mcp_policy_ensure BEFORE INSERT ON policy_owner_states FOR EACH ROW EXECUTE FUNCTION mcp_policy_ensure_fault()",
        ]);
        await queryFailure("actual policy owner INSERT failure", "ensure", [
          h.owner,
        ]);
        await call(
          "required argument fails before actual owner INSERT",
          "policy.read",
          {},
          400,
        );
        await h.fixture.sql([
          "DROP TRIGGER mcp_policy_ensure ON policy_owner_states",
          "DROP FUNCTION mcp_policy_ensure_fault()",
        ]);
        // These views fail inside real SELECTs. Conditional faults distinguish
        // an effective list from the later exact-record/count queries.
        for (const fault of [
          {
            key: "project",
            table: "projects",
            condition: "current_query() ~* '^select (\"id\"|id) from'",
            params: [project, h.owner, 1],
          },
          {
            key: "eligible",
            table: "policies",
            params: [h.owner, true, "ide", "both"],
          },
          {
            key: "direct",
            table: "project_policy_assignments",
            params: [project],
          },
          {
            key: "workspace",
            table: "workspace_policy_assignments",
            params: [h.owner, project],
          },
          {
            key: "get",
            table: "policies",
            condition: "current_query() ~* 'limit'",
            params: [policyIds.workspace, h.owner, 1],
            operation: "policy.read",
          },
          {
            key: "workspaceCount",
            table: "workspace_policy_assignments",
            condition: "current_query() ~* 'count'",
            params: [policyIds.workspace],
            operation: "policy.read",
          },
          {
            key: "projectCount",
            table: "project_policy_assignments",
            condition: "current_query() ~* 'count'",
            params: [policyIds.workspace],
            operation: "policy.read",
          },
        ]) {
          await h.fixture.sql([
            `ALTER TABLE ${fault.table} RENAME TO mcp_policy_fault_storage`,
            `CREATE FUNCTION mcp_policy_select_fault() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$ BEGIN IF ${fault.condition ?? "true"} THEN RAISE EXCEPTION 'actual MCP policy SELECT failure'; END IF; RETURN true; END $$`,
            `CREATE VIEW ${fault.table} AS SELECT s.* FROM mcp_policy_fault_storage s WHERE mcp_policy_select_fault()`,
          ]);
          await queryFailure(
            "actual " + fault.key + " query failure",
            fault.key,
            fault.params,
            fault.operation,
            fault.operation ? { policyId: policyIds.workspace } : {},
          );
          if (fault.key === "eligible")
            await queryFailure(
              "effective query failure precedes missing policy lookup",
              fault.key,
              fault.params,
              "policy.read",
              { policyId: "not-effective" },
            );
          await h.fixture.sql([
            `DROP VIEW ${fault.table}`,
            `ALTER TABLE mcp_policy_fault_storage RENAME TO ${fault.table}`,
            "DROP FUNCTION mcp_policy_select_fault()",
          ]);
        }
        // Overflow rows are never returned or decrypted: the existing opaque
        // content merely exercises the server's metadata cardinality limit.
        await h.fixture.sql([
          `INSERT INTO policies(id,owner_id,key_blind_index,protected_summary,protected_body,mandatory) SELECT 'eeeeeeee-eeee-4eee-8eee-'||lpad(i::text,12,'0'),${literal(h.owner)},lpad(i::text,43,'0'),${json(policies.get(policyIds.mandatory).content.protectedSummary)},${json(policies.get(policyIds.mandatory).content.protectedBody)},true FROM generate_series(600,${600 + assets.effectivePolicyLimit}) AS i`,
        ]);
        const overflow = await call(
          "effective policy limit retains generic MCP conflict classification",
          "policy.list",
          {},
          400,
        );
        assert.equal(
          overflow.error,
          `Project ${project} has more than ${assets.effectivePolicyLimit} effective policies. Reduce or consolidate its effective policies before starting another Agent turn.`,
        );
        assert.equal(overflow.code, "invalid");
        await h.fixture.sql([
          "DELETE FROM policies WHERE id LIKE 'eeeeeeee-eeee-4eee-8eee-%' AND substring(id from 25)::integer >= 600",
        ]);

        h.worker.close();
        await h.live.close();
        const port = Number(new URL(h.fixture.server.origin).port);
        await h.fixture.close();
        await h.fixture.start({ port });
        await h.reconnectWorker();
        await call(
          "old inactive caller is rejected after server restart",
          "policy.list",
          {},
          409,
        );
        await h.fixture.sql([
          `UPDATE chats SET status='running' WHERE id=${literal(chat)}`,
        ]);
        binding.issuedAt = new Date().toISOString();
        binding.expiresAt = new Date(Date.now() + 120000).toISOString();
        const retained = await read(
          "encrypted policy and assignment counts survive actual restart",
          policyIds.workspace,
        );
        assert.deepEqual(retained.data, original.data);
        result.actualServerRestartVerified = true;

        const standalone = "eeeeeeee-eeee-4eee-8eee-000000000508";
        await h.fixture.sql([
          `INSERT INTO chats(id,owner_id,context_kind,protected_label,active_worker_id,active_scratch_root_id,worktree_mode,status,permission_profile_id) VALUES(${literal(standalone)},${literal(h.owner)},'standalone',${json(label("chat"))},${literal(worker)},'mcp-policy-scratch',NULL,'running',':workspace')`,
          `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,protected_path_handle,status) VALUES('mcp-policy-scratch',${literal(standalone)},${literal(h.owner)},${literal(worker)},'ctrr_${"A".repeat(43)}','ready')`,
          `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,scratch_root_id,codex_thread_id) VALUES('mcp-policy-standalone-runtime',${literal(standalone)},${literal(worker)},'mcp-policy-scratch','mcp-policy-standalone-thread')`,
          `INSERT INTO chat_execution_lanes(id,chat_id,scratch_root_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('mcp-policy-standalone-lane',${literal(standalone)},'mcp-policy-scratch',${literal(worker)},'agent',false,'Qualification','active',now(),'mcp-policy-standalone-runtime')`,
        ]);
        for (const operation of [
          "context.compact",
          "policy.list",
          "policy.read",
        ]) {
          assert.deepEqual(
            await call(
              "standalone " + operation + " retains unsupported capability",
              operation,
              {},
              409,
              {
                ...binding,
                contextKind: "standalone",
                projectId: null,
                chatId: standalone,
                executionLaneId: "mcp-policy-standalone-lane",
                worktreeId: null,
                rootKind: null,
                scratchRootId: "mcp-policy-scratch",
              },
            ),
            {
              code: "unsupported-capability",
              error:
                "Standalone Chats do not support IDE execution operations.",
            },
          );
        }
        const [audit] = await h.fixture.sql(
          [],
          [
            "SELECT jsonb_build_object('events',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM audit_events a WHERE a.action LIKE 'mcp.operation.%'),'[]'::jsonb))::text result",
          ],
        );
        const calls = new Map(
          result.calls.map((call) => [call.httpRequestId, call]),
        );
        assert.equal(audit.events.length, result.calls.length);
        result.auditEvents = audit.events.map((event) => {
          const observed = calls.get(event.request_id);
          assert.ok(observed);
          assert.equal(event.owner_id, h.owner);
          assert.equal(event.actor_user_id, null);
          assert.equal(event.actor_session_id, null);
          assert.equal(event.resource_type, "mcp-binding");
          assert.equal(event.resource_id, binding.bindingId);
          assert.equal(
            event.action,
            observed.status !== 200
              ? "mcp.operation.rejected"
              : observed.body.mutated
                ? "mcp.operation.mutated"
                : "mcp.operation.executed",
          );
          assert.equal(
            event.result,
            observed.status === 200
              ? "succeeded"
              : ["forbidden", "stale-binding", "expired"].includes(
                    observed.body.code,
                  )
                ? "denied"
                : "failed",
          );
          return {
            name: observed.name,
            action: event.action,
            result: event.result,
          };
        });
        for (const observed of result.calls)
          observed.comparisonBody ??= comparison(observed.body);
        assert.ok(!JSON.stringify(result.calls).includes(privateMarker));
        assert.ok(!JSON.stringify(result.commands).includes(privateMarker));
        assert.ok(!h.diagnostics().includes(privateMarker));
        result.decryptedPolicyReads = decryptedPolicyReads;
      } finally {
        result.diagnostics = h.diagnostics();
        await h.close();
        h = undefined;
      }
    }
    if (p.peers.length === 2) {
      const [node, rust] = p.peers;
      assert.equal(node.calls.length, rust.calls.length);
      for (let index = 0; index < node.calls.length; index++) {
        const a = node.calls[index],
          b = rust.calls[index];
        if (
          !isDeepStrictEqual(
            [a.name, a.status, a.comparisonBody],
            [b.name, b.status, b.comparisonBody],
          )
        )
          p.differences.push({ node: a, rust: b });
      }
      if (!isDeepStrictEqual(node.auditEvents, rust.auditEvents))
        p.differences.push({
          nodeAudit: node.auditEvents,
          rustAudit: rust.auditEvents,
        });
    }
  }
  report.sourceAssertionsPassed = true;
  report.compatibilityPassed =
    peers.length === 2 &&
    report.profiles.every((p) => p.differences.length === 0);
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await h?.close();
  await postgres?.close();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      report: reportPath,
      compatibilityPassed: report.compatibilityPassed,
      sourceAssertionsPassed: report.sourceAssertionsPassed,
      profiles: report.profiles.map((p) => ({
        profile: p.profile,
        calls: p.peers.map((peer) => peer.calls.length),
        differences: p.differences.length,
      })),
      failure: report.failure,
    }),
  );
}
if (failure) throw failure;
assert.equal(
  peers.length === 2
    ? report.compatibilityPassed
    : report.sourceAssertionsPassed,
  true,
);
