#!/usr/bin/env node
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

const [source, destination] = process.argv.slice(2);
if (!source || !destination)
  throw new Error("usage: copy-license-files.mjs SOURCE DESTINATION");
await mkdir(destination, { recursive: true });
let copied = 0;
await visit(source);
if (copied === 0)
  throw new Error(`no license or notice files found below ${source}`);

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(absolute);
      continue;
    }
    if (!/^(license|copying|notice|python\.json)/i.test(entry.name)) continue;
    if ((await stat(absolute)).size > 2_000_000) continue;
    const relative = path.relative(source, absolute).replaceAll(path.sep, "__");
    await cp(absolute, path.join(destination, relative));
    copied += 1;
  }
}
