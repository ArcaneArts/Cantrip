import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it, expect } from "vitest";
import { remoteControl } from "../src/os-executor/connection.js";
import { OsServiceStream } from "../src/os-executor/service-stream.js";
import { RfbStreamProbe } from "./fixtures/rfb-stream-probe.js";
import {
  StreamWorkload,
  docker,
  sample,
} from "./fixtures/os-stream-workload.js";
import {
  streamViewer,
  type StreamDesktop,
} from "./fixtures/os-stream-viewer.js";
const exec = promisify(execFile);
const container = process.env.CANTRIP_OS_STREAM_TEST_CONTAINER;
const output = process.env.CANTRIP_OS_STREAM_OUTPUT;
const duration = 10_000;

/** Opt-in local backend benchmark. No browser decode, WAN or signed admission timing claims. */
describe.skipIf(!container)("actual matched Linux stream measurements", () => {
  it("measures native adaptive JPEG and ZRLE VNC against the same X11 workload", async () => {
    const transport = { kind: "docker" as const, container: container! };
    await exec("docker", [
      "cp",
      path.resolve("../cantrip_os/tests/stream-workload.py"),
      `${container}:/tmp/stream-workload.py`,
    ]);
    const a = await remoteControl<StreamDesktop>(transport, ["open", "cua-a"]);
    const b = await remoteControl<StreamDesktop>(transport, ["open", "cua-b"]);
    let frames = 0,
      bytes = 0,
      first: (() => void) | undefined;
    const frame = (size: number) => {
      frames++;
      bytes += size;
      first?.();
      first = undefined;
    };
    const workload = new StreamWorkload(container!, a.uid, a.display);
    const viewer = await streamViewer(transport, frame);
    const siblingClipboard = "sibling-clipboard-must-stay";
    await docker(
      container!,
      "sh",
      "-c",
      `printf '%s' '${siblingClipboard}' | runuser -u ctw-cua-b -- env DISPLAY=:${b.display} xclip -selection clipboard`,
    );
    const evidence = {
      recordedAt: new Date().toISOString(),
      container,
      geometry: [1440, 900],
      targetFps: 15,
      scope:
        "local protected Docker carrier; production Native JPEG surface; real compressed ZRLE updates; encoded arrivals, not display/decode latency; guest XSync key acknowledgment; Host process CPU includes probe; no network emulation",
      candidates: [] as unknown[],
    };
    let vnc: RfbStreamProbe | undefined, stream: OsServiceStream | undefined;
    const firstFrame = async (open: () => Promise<unknown>) => {
      let timer: ReturnType<typeof setTimeout>;
      const ready = new Promise<void>((resolve, reject) => {
        first = resolve;
        timer = setTimeout(() => {
          first = undefined;
          reject(new Error("Actual stream emitted no frame."));
        }, 30_000);
      });
      const start = performance.now();
      try {
        await open();
        await ready;
        return performance.now() - start;
      } finally {
        clearTimeout(timer!);
      }
    };
    try {
      await workload.ready;
      for (const kind of ["native-jpeg", "vnc-zrle"] as const) {
        const open = async () => {
          if (kind === "native-jpeg") return viewer.open();
          const descriptor = await remoteControl<Record<string, unknown>>(
            transport,
            ["service-info", "cua-a", "--service", '{"kind":"vnc"}'],
          );
          stream = await new OsServiceStream(
            transport,
            "cua-a",
            descriptor,
          ).ready();
          vnc = new RfbStreamProbe(stream, frame);
          await vnc.start();
        };
        const close = async () => {
          if (kind === "native-jpeg") await viewer.disconnect();
          else {
            await vnc?.close();
            await stream?.confirmRetired();
          }
        };
        const firstEncodedFrameMs = await firstFrame(open);
        const stages = [];
        for (const phase of ["static", "motion"]) {
          await workload.command({ phase, sequence: 0 });
          await delay(1000);
          const before = await sample(container!);
          const cpu = process.cpuUsage();
          frames = 0;
          bytes = 0;
          const start = performance.now();
          await delay(duration);
          const elapsed = performance.now() - start,
            host = process.cpuUsage(cpu),
            after = await sample(container!);
          if (phase === "motion") expect(frames).toBeGreaterThan(0);
          expect(after.limit).toBe("4294967296");
          expect(after.oom).toMatch(/oom_kill 0/u);
          stages.push({
            phase,
            elapsedMs: elapsed,
            encodedFrames: frames,
            encodedBytes: bytes,
            fps: frames / (elapsed / 1000),
            megabitsPerSecond: (bytes * 8) / elapsed / 1000,
            guestCpuPercentOfOneCore:
              (after.cpuUsec - before.cpuUsec) / elapsed / 10,
            hostCpuPercentOfOneCore: (host.user + host.system) / elapsed / 10,
            memory: after.memory,
            anonymous: after.anonymous,
            workingSet: after.workingSet,
          });
        }
        await workload.command({ phase: "static", sequence: 0 });
        const inputToGuestPaintAckMs = [];
        for (let index = 0; index < 5; index++) {
          const received = workload.key(),
            start = performance.now();
          if (kind === "native-jpeg") await viewer.key();
          else vnc!.key();
          inputToGuestPaintAckMs.push((await received) - start);
          await delay(100);
        }
        const clipboardText = `${kind}-actual-clipboard`;
        if (kind === "native-jpeg") await viewer.clipboard(clipboardText);
        else vnc!.clipboard(clipboardText);
        let clipboard = "";
        for (let tries = 0; tries < 20; tries++) {
          clipboard = await docker(
            container!,
            "runuser",
            "-u",
            "ctw-cua-a",
            "--",
            "env",
            `DISPLAY=:${a.display}`,
            "xclip",
            "-selection",
            "clipboard",
            "-o",
          );
          if (clipboard === clipboardText) break;
          await delay(50);
        }
        expect(clipboard).toBe(clipboardText);
        expect(
          await docker(
            container!,
            "runuser",
            "-u",
            "ctw-cua-b",
            "--",
            "env",
            `DISPLAY=:${b.display}`,
            "xclip",
            "-selection",
            "clipboard",
            "-o",
          ),
        ).toBe(siblingClipboard);
        await close();
        const reconnectFirstEncodedFrameMs = await firstFrame(open);
        await close();
        const row = {
          kind,
          firstEncodedFrameMs,
          reconnectFirstEncodedFrameMs,
          inputToGuestPaintAckMs,
          clipboard: "actual ASCII selection round-trip; sibling unchanged",
          stages,
        };
        evidence.candidates.push(row);
        console.log(JSON.stringify(row));
      }
      if (output) {
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
      }
    } finally {
      await vnc?.close();
      await stream?.confirmRetired();
      await viewer.close();
      await workload.close();
    }
  }, 180_000);
});
