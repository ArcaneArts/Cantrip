// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  clearSensitiveBytes,
  decryptSurfaceStreamPayload,
  deriveComponentKey,
} from "@cantrip/crypto";
import {
  workerLinkLeaseSchema,
  workerLinkResourceGrantSchema,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";
import { productTestContext } from "./os-product-test-support";
import { openTerminalWorkerLink } from "./terminal-worker-link";

const origin = process.env.CANTRIP_OS_PRODUCT_TEST_ORIGIN;
const recovery = process.env.CANTRIP_OS_PRODUCT_TEST_RECOVERY;
const terminalId = process.env.CANTRIP_OS_PRODUCT_TEST_TERMINAL;
const workerId = process.env.CANTRIP_OS_PRODUCT_TEST_WORKER;
const expectedText = process.env.CANTRIP_OS_PRODUCT_TEST_TERMINAL_TEXT;

describe.skipIf(
  !origin || !recovery || !terminalId || !workerId || !expectedText,
)("actual product native Linux console", () => {
  it("opens the owned console through Server grants and decrypts its retained output over WorkerLink", async () => {
    const context = await productTestContext(origin!, recovery!);
    const key = deriveComponentKey({
      accountMasterKey: context.master,
      ownerId: context.recovery.ownerId,
      component: "surface-private-state",
      keyRevision: context.recovery.masterKeyRevision,
    });
    const operationId = randomUUID();
    let connection:
      Awaited<ReturnType<typeof openTerminalWorkerLink>> | undefined;
    let output = "";
    let sequence = 0;
    let received = false;
    const events: string[] = [];
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      connection = await openTerminalWorkerLink(
        {
          terminalId: terminalId!,
          workerId: workerId!,
          operationId,
          onClose(code) {
            events.push(`closed:${code}`);
            finish();
          },
          async onMessage(message) {
            events.push(message.type);
            if (message.type !== "output") return;
            expect(message.operationId).toBe(operationId);
            expect(message.sequence).toBe(sequence++);
            const plaintext = await decryptSurfaceStreamPayload({
              ownerId: context.recovery.ownerId,
              componentKey: key,
              keyRevision: context.recovery.masterKeyRevision,
              context: {
                serverId: context.recovery.serverId,
                surfaceKind: "terminal",
                surfaceId: terminalId!,
                operationId,
                direction: "output",
                sequence: message.sequence,
              },
              opaque: message.protectedData,
            });
            try {
              const content = JSON.parse(new TextDecoder().decode(plaintext));
              expect(content.type).toBe("terminal.output");
              expect(typeof content.data).toBe("string");
              // Keep the observation bounded even if the console is producing
              // live output. No terminal input or model command is sent.
              output = (output + content.data).slice(-2_000_000);
              received = true;
              if (output.includes(expectedText!)) finish();
            } finally {
              clearSensitiveBytes(plaintext);
            }
          },
        },
        {
          manager: context.manager,
          now: Date.now,
          createGrant: async (session, terminal, operation) =>
            workerLinkResourceGrantSchema.parse(
              await context.api(
                `/api/worker-links/${session}/terminals/${terminal}/grant`,
                { operationId: operation },
              ),
            ),
          renewGrant: async (session, grant) =>
            workerLinkLeaseSchema.parse(
              await context.api(
                `/api/worker-links/${session}/grants/${grant}/renew`,
                {},
              ),
            ),
          revokeGrant: async (session, grant) => {
            await context.api(
              `/api/worker-links/${session}/grants/${grant}`,
              undefined,
              "DELETE",
            );
          },
        },
      );
      connection.activate();
      const deadline = setTimeout(finish, 10_000);
      try {
        await done;
      } finally {
        clearTimeout(deadline);
      }
      await connection.drain();
      expect(received).toBe(true);
      expect(output).toContain(expectedText!);
      const evidence = process.env.CANTRIP_OS_PRODUCT_TEST_EVIDENCE;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await writeFile(
          path.join(evidence, "native-console-product.json"),
          JSON.stringify(
            {
              terminalId,
              workerId,
              route: connection.route,
              authenticatedFrames: sequence,
              retainedCharacters: output.length,
              expectedText,
              matched: true,
              events,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      connection?.close();
      try {
        await context.close();
      } finally {
        clearSensitiveBytes(key);
      }
    }
  }, 90_000);
});
