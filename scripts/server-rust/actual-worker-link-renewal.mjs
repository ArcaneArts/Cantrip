import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";
import { deadline, NativeBrokerClient } from "./native-broker-client.mjs";

const telemetry = {
  bytesFromLocal: 0,
  bytesToLocal: 0,
  connectionsClosed: 0,
  connectionsOpened: 0,
};

async function authorityStatuses(page, authority) {
  const { session, peer, binding } = authority;
  return page.evaluate(
    async ({ sessionId, peerId, capabilityId, telemetry }) => {
      const api = await import("/src/lib/api/worker-link.ts");
      const { CantripApiError } = await import("/src/lib/api-client.ts");
      const status = async (operation) => {
        try {
          await operation();
          return 200;
        } catch (error) {
          if (!(error instanceof CantripApiError)) throw error;
          return error.status;
        }
      };
      return {
        session: await status(() => api.renewWorkerLinkSession(sessionId)),
        peer: await status(() =>
          api.readWorkerLinkPeerMailbox(sessionId, peerId),
        ),
        direct: await status(() =>
          api.recordDirectAttachmentTelemetry(capabilityId, telemetry),
        ),
      };
    },
    {
      sessionId: session.sessionId,
      peerId: peer.peerSessionId,
      capabilityId: binding.capabilityId,
      telemetry,
    },
  );
}

const missing = { session: 404, peer: 404, direct: 404 };

async function release(page, authority) {
  await page.evaluate(async (sessionId) => {
    const api = await import("/src/lib/api/worker-link.ts");
    await api.deleteWorkerLinkSession(sessionId);
  }, authority.session.sessionId);
}

function assertExtended(before, after) {
  assert.equal(after.issuedAt, before.issuedAt);
  assert.equal(after.absoluteExpiresAt, before.absoluteExpiresAt);
  assert.ok(Date.parse(after.expiresAt) > Date.parse(before.expiresAt));
  assert.ok(Date.parse(after.expiresAt) <= Date.parse(after.absoluteExpiresAt));
}

export async function actualWorkerLinkRenewal({
  page,
  workerId,
  getWorker,
  startWorker,
  crashWorker,
  restartServer,
  binary,
  result,
}) {
  const runs = (result.workerLinkLeaseRecovery = { phases: [] });
  const brokers = new Set();
  const waitWorker = (online) =>
    eventually(
      () => page.evaluate(() => window.folderWorkers.getWorkers()),
      (workers) => {
        const worker = workers.find((worker) => worker.workerId === workerId);
        assert.equal(worker?.online, online);
        if (online) assert.equal(worker.directBroker?.leaseRenewal, true);
      },
    );
  const open = async (phase) => {
    const worker = getWorker();
    const { session, peer, ticket } = await page.evaluate(
      async ({ workerId, clientInstanceId }) => {
        const api = await import("/src/lib/api/worker-link.ts");
        const session = await api.createWorkerLinkSession(
          workerId,
          clientInstanceId,
        );
        const { peerSession: peer } = await api.createWorkerLinkPeerSession(
          session.sessionId,
          session.routeGeneration,
          "lan",
        );
        const ticket = await api.createWorkerLinkDirectTicket(
          session.sessionId,
        );
        return { session, peer, ticket };
      },
      { workerId, clientInstanceId: "lease-recovery-" + phase },
    );
    const broker = new NativeBrokerClient(binary, { ticket });
    brokers.add(broker);
    const verified = await broker.ready();
    assert.equal(verified.event, "verified", JSON.stringify(verified));
    assert.equal(verified.workerId, workerId);
    assert.equal(verified.brokerInstanceId, ticket.broker.instanceId);
    assert.equal(ticket.binding.leaseExpiresAt, session.lease.expiresAt);
    assert.equal(ticket.binding.resourceKind, "worker-link");
    assert.equal(ticket.binding.resourceId, session.sessionId);
    assert.equal(peer.route, "lan");
    assert.equal(peer.lease.expiresAt, session.lease.expiresAt);
    await page.evaluate(
      async ({ sessionId, capabilityId }) => {
        const api = await import("/src/lib/api/worker-link.ts");
        await api.activateWorkerLinkDirectTicket(sessionId, capabilityId);
      },
      {
        sessionId: session.sessionId,
        capabilityId: ticket.binding.capabilityId,
      },
    );
    const observation = {
      phase,
      workerPid: worker.child.pid,
      broker: verified,
      session,
      peer,
      binding: ticket.binding,
    };
    runs.phases.push(observation);
    return { ...observation, broker, worker, observation };
  };
  const renew = async (authority) => {
    const { session, peer, binding, broker, worker, observation } = authority;
    const renewed = await page.evaluate(
      async ({ session, peer }) => {
        const api = await import("/src/lib/api/worker-link.ts");
        const parent = await api.renewWorkerLinkSession(session.sessionId);
        const { peerSession: currentPeer } =
          await api.createWorkerLinkPeerSession(
            session.sessionId,
            session.routeGeneration,
            peer.route,
          );
        const mailbox = await api.readWorkerLinkPeerMailbox(
          session.sessionId,
          peer.peerSessionId,
        );
        return { parent, peer: currentPeer, mailbox };
      },
      { session, peer },
    );
    assert.deepEqual(renewed.parent, {
      ...session,
      lease: renewed.parent.lease,
    });
    assert.deepEqual(renewed.peer, { ...peer, lease: renewed.peer.lease });
    assertExtended(session.lease, renewed.parent.lease);
    assertExtended(peer.lease, renewed.peer.lease);
    assert.equal(renewed.peer.lease.expiresAt, renewed.parent.lease.expiresAt);
    assert.equal(renewed.mailbox.peerSessionId, peer.peerSessionId);
    assert.equal(renewed.mailbox.sessionId, session.sessionId);
    observation.renewed = renewed;
    // The LOCAL ticket starts with the parent's two-minute expiry. Its first
    // real extension is possible once a new 60-second lease goes past it.
    await delay(
      Math.max(0, Date.parse(binding.leaseExpiresAt) - Date.now() - 59_000),
    );
    await page.evaluate(
      async ({ capabilityId, telemetry }) => {
        const api = await import("/src/lib/api/worker-link.ts");
        await api.recordDirectAttachmentTelemetry(capabilityId, telemetry);
      },
      { capabilityId: binding.capabilityId, telemetry },
    );
    const renewal = worker
      .diagnostics()
      .split("\n")
      .find(
        (line) =>
          line.includes("event=direct.capability.renewed") &&
          line.includes(binding.attachmentId),
      );
    assert.ok(
      renewal,
      "real worker logged extension of this direct capability",
    );
    assert.equal(broker.exit, undefined);
    assert.equal(broker.closed, undefined);
    observation.workerRenewalLog = renewal;
  };
  try {
    await waitWorker(true);
    const initial = await open("initial");
    await renew(initial);

    await crashWorker();
    const brokerExit = await deadline(
      initial.broker.exited,
      "Broker stayed open after its worker died",
    );
    assert.equal(brokerExit.signal, null);
    assert.ok(
      brokerExit.code === 0 ||
        (brokerExit.code === 1 &&
          /reset|closed|broken pipe/iu.test(initial.broker.stderr)),
      initial.broker.stderr,
    );
    runs.workerInterruptionBroker = {
      ...brokerExit,
      close: initial.broker.closed ?? null,
      stderr: initial.broker.stderr,
    };
    brokers.delete(initial.broker);
    await waitWorker(false);
    runs.workerInterruption = await authorityStatuses(page, initial);
    assert.deepEqual(runs.workerInterruption, {
      session: 503,
      peer: 200,
      direct: 503,
    });
    await startWorker();
    await waitWorker(true);
    runs.workerReplacementStaleAuthority = await authorityStatuses(
      page,
      initial,
    );
    assert.deepEqual(runs.workerReplacementStaleAuthority, missing);
    const replaced = await open("worker-restarted");
    assert.notEqual(replaced.workerPid, initial.workerPid);
    assert.notEqual(
      replaced.session.identity.workerProcessGeneration,
      initial.session.identity.workerProcessGeneration,
    );
    assert.equal(
      replaced.session.identity.serverGeneration,
      initial.session.identity.serverGeneration,
    );
    assert.notEqual(
      replaced.observation.broker.brokerInstanceId,
      initial.observation.broker.brokerInstanceId,
    );
    await renew(replaced);

    const connections = () =>
      replaced.worker.diagnostics().split("event=worker.connection.connected")
        .length;
    const before = connections();
    runs.serverInterruption = await restartServer();
    await eventually(connections, (count) => assert.ok(count > before), 60_000);
    await waitWorker(true);
    runs.serverInterruptionStaleAuthority = await authorityStatuses(
      page,
      replaced,
    );
    assert.deepEqual(runs.serverInterruptionStaleAuthority, missing);
    await replaced.broker.close();
    brokers.delete(replaced.broker);
    const recovered = await open("server-restarted");
    assert.equal(recovered.workerPid, replaced.workerPid);
    assert.equal(
      recovered.session.identity.serverId,
      initial.session.identity.serverId,
    );
    assert.equal(
      recovered.session.identity.ownerId,
      initial.session.identity.ownerId,
    );
    assert.equal(
      recovered.session.identity.workerProcessGeneration,
      replaced.session.identity.workerProcessGeneration,
    );
    assert.notEqual(
      recovered.session.identity.serverGeneration,
      replaced.session.identity.serverGeneration,
    );
    assert.equal(
      recovered.observation.broker.brokerInstanceId,
      replaced.observation.broker.brokerInstanceId,
    );
    for (const key of ["sessionId", "peerSessionId", "capabilityId"])
      assert.equal(
        new Set(
          runs.phases.map(
            ({ session, peer, binding }) =>
              ({ ...session, ...peer, ...binding })[key],
          ),
        ).size,
        3,
        key,
      );
    await renew(recovered);
    await release(page, recovered);
    runs.releasedBroker = await eventually(
      () => recovered.broker.closed,
      (event) => assert.equal(event?.code, 1008),
    );
    runs.releasedAuthority = await authorityStatuses(page, recovered);
    assert.deepEqual(runs.releasedAuthority, missing);
    result.steps.push(
      "real LAN peer and native LOCAL broker renew on the production worker before and after worker and server crashes; each old authority is rejected",
    );
  } finally {
    await Promise.all([...brokers].map((broker) => broker.close()));
  }
}
