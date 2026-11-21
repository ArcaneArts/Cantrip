import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
export async function docker(container: string, ...args: string[]) {
  return (
    await exec("docker", ["exec", container, ...args], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout;
}
export async function sample(container: string) {
  return JSON.parse(
    await docker(
      container,
      "python3",
      "-c",
      `import json,pathlib
p=pathlib.Path('/sys/fs/cgroup');m={k:int(v) for k,v in (line.split() for line in (p/'memory.stat').read_text().splitlines())};c={k:int(v) for k,v in (line.split() for line in (p/'cpu.stat').read_text().splitlines())}
print(json.dumps({'memory':int((p/'memory.current').read_text()),'workingSet':max(0,int((p/'memory.current').read_text())-m.get('inactive_file',0)),'anonymous':m.get('anon',0),'cpuUsec':c['usage_usec'],'limit':(p/'memory.max').read_text().strip(),'oom':(p/'memory.events').read_text()}))`,
    ),
  ) as {
    memory: number;
    workingSet: number;
    anonymous: number;
    cpuUsec: number;
    limit: string;
    oom: string;
  };
}
type Waiter<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
/** Actual application acknowledgments after XSync, not displayed-frame latency. */
export class StreamWorkload {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiters = new Map<string, Waiter<unknown>>();
  private keyWaiter?: Waiter<number>;
  private readyResolve!: (value: unknown) => void;
  private readyReject!: (error: Error) => void;
  readonly ready: Promise<unknown>;
  private readonly exited: Promise<void>;
  constructor(container: string, uid: number, display: number) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const timer = setTimeout(
      () => this.fail(new Error("Actual X11 workload did not start.")),
      10_000,
    );
    this.child = spawn(
      "docker",
      [
        "exec",
        "-i",
        "-u",
        String(uid),
        "-e",
        `DISPLAY=:${display}`,
        container,
        "python3",
        "-u",
        "/tmp/stream-workload.py",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let error = "";
    this.child.stderr.on("data", (b) => {
      error = (error + b.toString()).slice(-4096);
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.ready) {
          clearTimeout(timer);
          this.readyResolve(message);
        }
        if (message.ack) {
          const w = this.waiters.get(message.ack);
          if (w) {
            clearTimeout(w.timer);
            this.waiters.delete(message.ack);
            w.resolve(message);
          }
        }
        if (message.key && this.keyWaiter) {
          const w = this.keyWaiter;
          this.keyWaiter = undefined;
          clearTimeout(w.timer);
          w.resolve(performance.now());
        }
      } catch (cause) {
        this.fail(new Error("Invalid workload acknowledgment", { cause }));
      }
    });
    this.child.once("error", (error) => {
      clearTimeout(timer);
      this.fail(error);
    });
    this.exited = new Promise((resolve) =>
      this.child.once("close", (code) => {
        clearTimeout(timer);
        this.fail(new Error(`X11 workload exited ${code}: ${error}`));
        resolve();
      }),
    );
  }
  private fail(error: Error) {
    this.readyReject(error);
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      w.reject(error);
    }
    this.waiters.clear();
    if (this.keyWaiter) {
      clearTimeout(this.keyWaiter.timer);
      this.keyWaiter.reject(error);
      this.keyWaiter = undefined;
    }
  }
  command(value: Record<string, unknown>) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error("Actual workload did not acknowledge its phase."));
      }, 10_000);
      this.waiters.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...value, id }) + "\n");
    });
  }
  key() {
    return new Promise<number>((resolve, reject) => {
      if (this.keyWaiter)
        throw new Error("Only one measured input may be pending.");
      const timer = setTimeout(() => {
        this.keyWaiter = undefined;
        reject(new Error("Actual X11 application did not receive input."));
      }, 10_000);
      this.keyWaiter = { resolve, reject, timer };
    });
  }
  async close() {
    this.child.stdin.end();
    await this.exited;
  }
}
