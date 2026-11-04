import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CantripCuaService } from "../src/computer-use/service.js";
import {
  remoteCommand,
  remoteControl,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";

const transport: OsExecutorTransport | null = process.env
  .CANTRIP_OS_CUA_TEST_TRANSPORT
  ? JSON.parse(readFileSync(process.env.CANTRIP_OS_CUA_TEST_TRANSPORT, "utf8"))
  : process.env.CANTRIP_OS_CUA_TEST_CONTAINER
    ? { kind: "docker", container: process.env.CANTRIP_OS_CUA_TEST_CONTAINER }
    : null;

interface Desktop {
  instance_id: string;
  generation: string;
  owner_id: string;
  worker_id: string;
  workspace_id: string;
  desktop_generation: string;
  remote_generation: string;
  uid: number;
  display: number;
}

describe.skipIf(!transport)(
  "actual packaged Linux CUA through the Worker service",
  () => {
    it("validates real capture, click, key and text receipts through the protected carrier", async () => {
      const context = await remoteControl<Desktop>(transport!, [
        "open",
        "cua-a",
      ]);
      const command = remoteCommand(transport!, [
        "connect",
        context.workspace_id,
        "--expect",
        JSON.stringify(context),
      ]);
      const service = new CantripCuaService({
        workerId: context.worker_id,
        binary: command.command,
        args: command.args,
      });
      const scope = {
        serverId: "os-cua-fixture",
        ownerId: context.owner_id,
        workerId: context.worker_id,
        chatId: "os-cua-fixture-chat",
        taskId: null,
        threadId: "os-cua-fixture-thread",
        turnId: "os-cua-fixture-turn",
      };
      try {
        const capabilities = await service.capabilities(scope);
        expect(capabilities.backend).toBe("linux-x11");
        const [target] = await service.targets(scope);
        expect(target.id).toBe(
          `x11-:${context.display}-${context.desktop_generation}`,
        );
        const reference = {
          targetId: target.id,
          targetGeneration: target.generation,
        };
        // Fixture scope explicitly authorizes the complete disposable display.
        // Product permission/placement admission is covered by its own integration.
        const session = await service.open(scope, reference, undefined, true);
        const id = session.binding.sessionId;
        const capture = await service.snapshot(scope, id, reference);
        expect(capture.payload.subarray(0, 8)).toEqual(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        const click = await service.click(scope, id, reference, {
          x: 500,
          y: 500,
        });
        expect(click.input).toMatchObject({
          method: "coordinate",
          position: { x: 500, y: 500 },
          globalPosition: { x: 500, y: 500 },
        });
        const key = await service.perform(scope, id, reference, {
          kind: "key",
          key: "Escape",
          modifiers: [],
        });
        expect(key.input).toMatchObject({
          method: "background-key",
          activation: false,
          windowDelivery: "unverified",
        });
        const text = await service.perform(scope, id, reference, {
          kind: "text",
          text: "Cantrip",
        });
        expect(text.input).toMatchObject({
          method: "background-text",
          activation: false,
          outcome: "dispatched",
        });
        // These receipts prove dispatch/protocol compatibility. Actual xterm bytes
        // are checked by the separate native Linux and product acceptance tests.
      } finally {
        await service.close();
      }
    }, 120_000);
  },
);
