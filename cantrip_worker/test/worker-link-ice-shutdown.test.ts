import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("WorkerLink ICE shutdown", () => {
  it.each(["import", "require"] as const)(
    "keeps a closed connection retired after real STUN gathering completes (%s)",
    async (entrypoint) => {
      const script = `
        import assert from "node:assert/strict";
        import { createSocket } from "node:dgram";
        import { once } from "node:events";
        import { createRequire } from "node:module";
        const { RTCIceGatherer } = ${entrypoint === "import" ? 'await import("werift")' : 'createRequire(import.meta.url)("werift")'};
        const server = createSocket("udp4");
        server.bind(0, "127.0.0.1");
        await once(server, "listening");
        const request = once(server, "message");
        const gatherer = new RTCIceGatherer({
          useIpv4: false,
          useIpv6: false,
          additionalHostAddresses: ["127.0.0.1"],
          stunServer: ["127.0.0.1", server.address().port],
        });
        const connection = gatherer.connection;
        connection.setRemoteParams({
          usernameFragment: "remote-fixture",
          password: "isolated-ice-fixture-password",
        });
        const states = [];
        connection.stateChanged.subscribe(state => states.push(state));
        const gathering = gatherer.gather();
        try {
          // The actual UDP request proves gathering owns a pending operation.
          // Leave the STUN request unanswered while retiring its connection.
          await request;
          await connection.close();
          const afterClose = connection.state;
          await gathering;
          const afterGather = connection.state;
          console.log(JSON.stringify({ afterClose, afterGather, states }));
          assert.equal(afterClose, "closed");
          assert.equal(afterGather, "closed");
          await assert.rejects(connection.connect(), /ICE negotiation failed/);
          console.log("ICE_CHILD_RETIRED");
        } finally {
          await connection.close();
          await gathering.catch(() => undefined);
          await new Promise(resolve => server.close(resolve));
        }
      `;
      // Natural child exit proves no referenced connection loop remains alive.
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--input-type=module", "--eval", script],
        { timeout: 20_000 },
      );
      expect(stdout).toContain('"afterClose":"closed"');
      expect(stdout).toContain('"afterGather":"closed"');
      expect(stdout).toContain("ICE_CHILD_RETIRED");
    },
    25_000,
  );
});
