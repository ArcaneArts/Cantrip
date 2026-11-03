// Measures a fresh disposable OS instance; never reuses the owner's desktop/data.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const exec = promisify(execFile);
const name = `cantrip-os-resource-${process.pid}`;
const image = process.env.CANTRIP_OS_TEST_IMAGE ?? "cantrip-os:dev";
const output =
  process.env.CANTRIP_OS_RESOURCE_OUTPUT ??
  "cantrip_os/artifacts/phase2/resources.json";
const docker = async (...args) =>
  (await exec("docker", args, { maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
let id;
const evidence = {
  image,
  limitBytes: 4294967296,
  workload:
    "personal IceWM desktop; package enabled; no viewers; two idle bash jobs in shell-only stage; workspace Chromium about:blank; 10s settle, 5 Docker stats samples per stage",
  stages: [],
};
async function measure(stage) {
  await delay(10000);
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const stats = JSON.parse(
      await docker("stats", "--no-stream", "--format", "{{json .}}", id),
    );
    const raw = Number(
      await docker("exec", id, "cat", "/sys/fs/cgroup/memory.current"),
    );
    samples.push({
      workingSet: stats.MemUsage,
      cpu: stats.CPUPerc,
      cgroupBytes: raw,
    });
  }
  evidence.stages.push({ stage, samples });
  console.log(JSON.stringify({ stage, samples }));
}
async function cli(...args) {
  return JSON.parse(await docker("exec", id, "cantrip-workspaces", ...args));
}
try {
  id = await docker(
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "--memory",
    "4g",
    "--memory-swap",
    "4g",
    "--shm-size",
    "1g",
    image,
  );
  const inspected = JSON.parse(await docker("inspect", id))[0];
  evidence.imageId = inspected.Image;
  evidence.actualLimitBytes = inspected.HostConfig.Memory;
  await docker(
    "exec",
    id,
    "sh",
    "-c",
    "for i in $(seq 1 200); do if cantrip-workspaces status | grep -q running; then exit 0; fi; sleep .1; done; exit 1",
  );
  await measure("idle OS");
  const a = await cli("create", "measure-a");
  const b = await cli("create", "measure-b");
  for (const row of [a, b]) {
    await docker(
      "exec",
      id,
      "sh",
      "-c",
      `mkdir -p '${row.home}/.icewm'; printf '#!/bin/sh\\ncantrip-browser about:blank >/dev/null 2>&1 &\\n' > '${row.home}/.icewm/startup'; chown -R ${row.uid}:${row.gid} '${row.home}/.icewm'; chmod 700 '${row.home}/.icewm/startup'`,
    );
  }
  for (const row of [a, b])
    await docker(
      "exec",
      "-d",
      "-u",
      String(row.uid),
      id,
      "bash",
      "--noprofile",
      "--norc",
      "-c",
      "while true; do sleep 30; done",
    );
  await measure("two shell-only workspaces");
  for (const row of [a, b])
    await docker("exec", id, "pkill", "-TERM", "-u", String(row.uid));
  for (const [index, row] of [a, b].entries()) {
    await cli("open", row.id);
    await docker(
      "exec",
      id,
      "sh",
      "-c",
      `for i in $(seq 1 200); do if pgrep -u ${row.uid} -x chromium >/dev/null; then exit 0; fi; sleep .1; done; exit 1`,
    );
    await measure(
      index === 0 ? "one desktop with Chromium" : "two desktops with Chromium",
    );
  }
  evidence.oomKilled = JSON.parse(
    await docker("inspect", id),
  )[0].State.OOMKilled;
  await mkdir(output.slice(0, output.lastIndexOf("/")), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Resource evidence: ${output}`);
} finally {
  if (id) await docker("stop", "--time", "30", id);
}
