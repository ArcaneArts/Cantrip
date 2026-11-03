#!/usr/bin/env node
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { root, run } from "./os.mjs";

const installed = process.argv.includes("--installed");
const headless = process.argv.includes("--headless");
const state = resolve(root, ".state");
const disk = resolve(state, "cantrip-os-test.qcow2");
await mkdir(state, { recursive: true });
try {
  await access(disk);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await run("qemu-img", ["create", "-f", "qcow2", disk, "16G"]);
}
const args = [
  "-machine",
  "q35",
  "-accel",
  "tcg",
  "-cpu",
  "max",
  "-smp",
  "2",
  "-m",
  "4096",
  "-device",
  "virtio-vga",
  "-device",
  "qemu-xhci",
  "-device",
  "usb-tablet",
  "-drive",
  `file=${disk},format=qcow2,if=virtio`,
  "-nic",
  "user,model=virtio-net-pci",
];
if (!installed)
  args.push(
    "-cdrom",
    resolve(root, "artifacts/cantrip-os-amd64.iso"),
    "-boot",
    "d",
  );
if (headless) {
  args.push(
    "-display",
    "none",
    "-vnc",
    "127.0.0.1:1",
    "-serial",
    `unix:${resolve(state, "console.sock")},server=on,wait=off`,
    "-monitor",
    `unix:${resolve(state, "monitor.sock")},server=on,wait=off`,
  );
  console.log(
    "Headless VM: VNC at 127.0.0.1:5901; serial/monitor sockets in .state/.",
  );
}
console.log(
  `VM disk: ${disk}. ${installed ? "Booting installed disk." : "Booting live ISO; installer target is /dev/vda."}`,
);
await run("qemu-system-x86_64", args);
