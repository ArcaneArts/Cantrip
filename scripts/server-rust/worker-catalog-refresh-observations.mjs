import assert from "node:assert/strict";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ordered = (value) => {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  return value;
};
const sort = (values) =>
  values
    .map(ordered)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

export function catalogRefreshObservations(peer) {
  assert.equal(peer.passed, true);
  assert.deepEqual(peer.exit, { code: 0, signal: null });
  const transfers = new Set();
  const commands = peer.commands
    .filter(({ command }) => command.provider.id.startsWith("refresh-"))
    .map(({ phase, command }) => {
      command = structuredClone(command);
      if (command.catalogPage) {
        assert.match(command.catalogPage.transferId, uuid);
        assert.ok(!transfers.has(command.catalogPage.transferId));
        transfers.add(command.catalogPage.transferId);
        command.catalogPage.transferId = "<fresh-transfer-id>";
      }
      return { phase, command };
    });
  const stages = peer.stages.map(({ phase, rows }) => {
    const batches = new Map();
    for (const row of rows) {
      assert.match(row.batch, /^refresh-\d+$/);
      const key = JSON.stringify([row.account, row.batch, row.trigger]);
      batches.set(key, (batches.get(key) ?? 0) + 1);
    }
    assert.ok([...batches.values()].every((count) => count === 2));
    return {
      phase,
      rows: sort(
        rows.map(({ batch, owner, ...row }) => ({
          ...row,
          owner: "<authenticated-owner>",
        })),
      ),
    };
  });
  return { commands: sort(commands), stages };
}

export function compareCatalogRefresh(report) {
  if (report.peers.length !== 2) return;
  const [source, native] = report.peers.map(catalogRefreshObservations);
  assert.deepEqual(
    native,
    source,
    "Worker command fields and persisted quota relationships match Source",
  );
  assert.deepEqual(
    report.peers[1].http,
    report.peers[0].http,
    "Actual normalized HTTP contracts match Source",
  );
  report.paired = {
    commands: source.commands.length,
    stages: source.stages.length,
    http: report.peers[0].http.length,
  };
}
