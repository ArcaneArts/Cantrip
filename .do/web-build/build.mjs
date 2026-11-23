import { execFileSync } from "node:child_process";
import { cp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const component = process.argv[2];
if (component !== "app" && component !== "site") {
  throw new Error("Usage: node build.mjs <app|site>");
}

const source = fileURLToPath(new URL(".", import.meta.url));
const root = path.resolve(source, "../..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpm = (...args) =>
  execFileSync(
    npm,
    ["exec", "--yes", "--package=pnpm@11.15.1", "--", "pnpm", ...args],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
// App Platform may check out only the release tip. The version needs its
// full commit history to calculate the patch against the pinned baseline.
const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (shallow === "true") {
  execFileSync("git", ["fetch", "--unshallow", "--no-tags", "origin"], {
    cwd: root,
    stdio: "inherit",
  });
}

const filter = `@cantrip/${component}...`;
pnpm("install", "--frozen-lockfile", "--ignore-scripts", "--prod=false");
pnpm("--filter", filter, "build");

const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const output = path.join(source, "dist");
await rm(output, { recursive: true, force: true });
await cp(path.join(root, `cantrip_${component}`, "dist"), output, {
  recursive: true,
});
await writeFile(path.join(output, "release.json"), JSON.stringify({ commit }));
