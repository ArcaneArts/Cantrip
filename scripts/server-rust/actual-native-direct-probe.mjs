// The desktop Rust probe connects to the unchanged full worker's real broker.
// This exercises the native component, not Tauri/WebView packaging or IPC.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

async function probe(binary, ticket) {
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "",
    diagnostic = "",
    timedOut = false;
  child.stdout.on("data", (bytes) => {
    output += bytes;
  });
  child.stderr.on("data", (bytes) => {
    diagnostic = (diagnostic + bytes).slice(-4096);
  });
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(ticket) + "\n");
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 10000);
  try {
    const ended = await result;
    assert.equal(
      timedOut,
      false,
      "Production native direct probe exceeded its connection/proof deadlines",
    );
    assert.equal(ended.code, 0, diagnostic);
    return JSON.parse(output);
  } finally {
    clearTimeout(timer);
  }
}

export async function actualNativeDirectProbe({
  page,
  workerId,
  binary,
  result,
}) {
  const create = () =>
    page.evaluate(
      async (workerId) =>
        (await import("/src/lib/api/workers.ts")).createDirectWorkerProbe(
          workerId,
        ),
      workerId,
    );
  const release = (capabilityId) =>
    page.evaluate(
      async (capabilityId) =>
        (await import("/src/lib/api/worker-link.ts")).deleteDirectAttachment(
          capabilityId,
        ),
      capabilityId,
    );
  const checks = [];
  const accepted = await create();
  try {
    assert.equal(accepted.binding.resourceKind, "probe");
    assert.equal(accepted.binding.resourceId, workerId);
    assert.deepEqual(accepted.binding.channels, ["probe"]);
    const local = await probe(binary, accepted);
    assert.equal(local.state, "local-direct");
    assert.equal(local.reason, null);
    assert.equal(local.workerId, workerId);
    assert.equal(local.brokerInstanceId, accepted.broker.instanceId);
    assert.ok(
      Number.isFinite(local.latencyMs) &&
        local.latencyMs >= 0 &&
        local.latencyMs < 6000,
    );
    checks.push({ kind: "signed-broker-proof", ...local });
    const reused = await probe(binary, accepted);
    assert.equal(reused.state, "relayed");
    assert.equal(reused.workerId, workerId);
    assert.equal(reused.brokerInstanceId, null);
    assert.ok(reused.reason);
    checks.push({ kind: "one-use-secret-rejected", ...reused });
  } finally {
    accepted.secret = "";
    await release(accepted.binding.capabilityId);
  }
  const revoked = await create();
  try {
    await release(revoked.binding.capabilityId);
    const rejected = await probe(binary, revoked);
    assert.equal(rejected.state, "relayed");
    assert.ok(rejected.reason);
    checks.push({ kind: "server-revocation-reaches-broker", ...rejected });
  } finally {
    revoked.secret = "";
    await release(revoked.binding.capabilityId);
  }
  const mismatched = await create();
  try {
    const broker = { ...mismatched.broker, fingerprint: "0".repeat(64) };
    assert.notEqual(broker.fingerprint, mismatched.broker.fingerprint);
    const rejected = await probe(binary, { ...mismatched, broker });
    assert.equal(rejected.state, "relayed");
    assert.match(rejected.reason, /identity did not match/u);
    checks.push({ kind: "mismatched-broker-identity-rejected", ...rejected });
  } finally {
    mismatched.secret = "";
    await release(mismatched.binding.capabilityId);
  }
  result.nativeDirectProbe = {
    desktopComponent: true,
    packagedDesktop: false,
    checks,
  };
  result.steps.push(
    "production desktop Rust probe verifies the real worker broker signature using a server-issued one-use capability",
  );
  result.steps.push(
    "production native probe rejects secret reuse, completed server revocation and mismatched broker identity",
  );
}
