import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  clearSensitiveBytes,
  deriveComponentKey,
  encryptEndpointContentPayload,
} from "@cantrip/crypto";
import {
  tunnelWireListSchema,
  tunnelWireSummarySchema,
  tunnelUserWireCreateSchema,
} from "@cantrip/protocol";
import { tunnelContentRecordSchema } from "@cantrip/protocol/tunnel-content";
import { productTestContext } from "./os-product-test-support";
import { productTestForward } from "./os-product-test-forward";

const origin = process.env.CANTRIP_OS_PRODUCT_TEST_ORIGIN;
const recoveryPath = process.env.CANTRIP_OS_PRODUCT_TEST_RECOVERY;
const run = promisify(execFile);
describe.skipIf(!origin || !recoveryPath)("actual product SSH/SFTP", () => {
  it("uses a saved encrypted Linux route, actual Server grant and WorkerLink relay with real OpenSSH clients", async () => {
    const context = await productTestContext(origin!, recoveryPath!);
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-product-ssh-"),
    );
    let tunnelId: string | undefined,
      forward: Awaited<ReturnType<typeof productTestForward>> | undefined;
    const keep = process.env.CANTRIP_OS_PRODUCT_TEST_KEEP_SSH_TUNNEL === "1";
    let dataKey = "";
    try {
      const tunnels = tunnelWireListSchema.parse(
        await context.api("/api/tunnels"),
      );
      const source = tunnels.find(
        (t) =>
          t.osSource &&
          t.destination.kind === "worker-adapter" &&
          t.destination.adapter === "cantrip-os",
      );
      expect(source?.osSource).toBeDefined();
      const keyPath = path.join(directory, "client");
      await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
      const publicKey = (await readFile(keyPath + ".pub", "utf8"))
        .trim()
        .split(/\s+/u)
        .slice(0, 2)
        .join(" ");
      tunnelId = randomUUID();
      dataKey = randomBytes(32).toString("base64url");
      const content = tunnelContentRecordSchema.parse({
        name: "CantripOS SSH product acceptance",
        description: null,
        source: { kind: "desktop-loopback" },
        destination: {
          kind: "worker-os-ssh",
          workerId: source!.destination.workerId,
          source: source!.osSource,
          publicKey,
        },
        dataProtection: {
          formatVersion: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          key: dataKey,
        },
      });
      const componentKey = deriveComponentKey({
        accountMasterKey: context.master,
        ownerId: context.recovery.ownerId,
        component: "tunnel-content",
        keyRevision: context.recovery.masterKeyRevision,
      });
      const plaintext = new TextEncoder().encode(JSON.stringify(content));
      let protectedContent;
      try {
        protectedContent = await encryptEndpointContentPayload({
          ownerId: context.recovery.ownerId,
          componentKey,
          keyRevision: context.recovery.masterKeyRevision,
          plaintext,
          context: {
            domain: "tunnel-content",
            serverId: context.recovery.serverId,
            workerId: source!.destination.workerId,
            scopeId: JSON.stringify(["tunnel", tunnelId]),
            operationId: tunnelId,
            operation: "tunnel.record",
            direction: "stored",
            sequence: 1,
          },
        });
      } finally {
        clearSensitiveBytes(componentKey);
        clearSensitiveBytes(plaintext);
      }
      const tunnel = tunnelWireSummarySchema.parse(
        await context.api(
          "/api/tunnels",
          tunnelUserWireCreateSchema.parse({
            id: tunnelId,
            projectId: source!.projectId,
            protocolHint: "tcp",
            destination: {
              kind: "worker-adapter",
              adapter: "cantrip-os",
              resourceId: tunnelId,
              workerId: source!.destination.workerId,
            },
            osSource: source!.osSource,
            protectedRecord: {
              operationId: tunnelId,
              revision: 1,
              protectedContent,
            },
          }),
        ),
      );
      expect(JSON.stringify(tunnel)).not.toContain(publicKey);
      forward = await productTestForward(context, tunnel, content);
      expect(forward.ssh?.user).toMatch(/^ctw-/u);
      const known = path.join(directory, "known_hosts");
      await writeFile(
        known,
        `${forward.ssh!.hostAlias} ${forward.ssh!.hostKey}\n`,
        { mode: 0o600 },
      );
      const options = [
        "-oBatchMode=yes",
        "-oConnectTimeout=15",
        "-oStrictHostKeyChecking=yes",
        `-oUserKnownHostsFile=${known}`,
        `-oHostKeyAlias=${forward.ssh!.hostAlias}`,
        "-oIdentitiesOnly=yes",
        "-i",
        keyPath,
      ];
      const target = `${forward.ssh!.user}@127.0.0.1`;
      const result = await run(
        "ssh",
        [
          ...options,
          "-p",
          String(forward.port),
          target,
          "id -u; pwd; sudo -n id -u",
        ],
        { timeout: 30_000 },
      );
      const lines = result.stdout.trim().split("\n");
      expect(Number(lines[0])).toBeGreaterThanOrEqual(20000);
      expect(lines[1]).toContain("/var/lib/cantrip-os-workspaces/homes/");
      expect(lines[2]).toBe("0");
      const local = path.join(directory, "input.txt"),
        downloaded = path.join(directory, "output.txt"),
        batch = path.join(directory, "sftp.batch");
      const remote = `cantrip-product-sftp-${randomUUID()}.txt`,
        payload = "Cantrip managed SFTP\ncafé 日本語\n";
      await writeFile(local, payload);
      await writeFile(
        batch,
        `put "${local}" ${remote}\nget ${remote} "${downloaded}"\nrm ${remote}\n`,
      );
      await run(
        "sftp",
        [...options, "-q", "-b", batch, "-P", String(forward.port), target],
        { timeout: 30_000 },
      );
      expect(await readFile(downloaded, "utf8")).toBe(payload);
      await forward.close();
      forward = undefined;
      if (keep)
        console.log(
          `Retained disposable SSH route ${tunnelId} and private client fixture at ${directory}; no key contents were logged.`,
        );
    } finally {
      await forward?.close();
      if (tunnelId && !keep)
        await context.api(`/api/tunnels/${tunnelId}`, undefined, "DELETE");
      dataKey = "";
      await context.close();
      if (!keep) await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
