#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { rootCertificates } from "node:tls";
import { cp, lstat, readdir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import {
  downloadPinned,
  extractedBytes,
  hostTarget,
  mkdir,
  readFile,
  rename,
  rm,
  run,
  sha256,
  stat,
  tarArgumentPath,
  writeFile,
} from "./searxng-lib.mjs";
import { inputRoot, readPlaywrightLock, root } from "./playwright-lib.mjs";

const execFileAsync = promisify(execFile);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const lock = await readPlaywrightLock();
const target = option("--target", hostTarget());
if (!target || !lock.targets[target])
  throw new Error(`unsupported Playwright target: ${target ?? "unknown"}`);
if (target !== hostTarget() && !process.argv.includes("--allow-cross"))
  throw new Error(
    `Playwright artifacts must be built natively (${target} requested)`,
  );

const outputRoot = path.resolve(
  option("--output", path.join(root, "dist", "managed-runtimes", "playwright")),
);
const cache = path.resolve(
  option("--cache", path.join(root, ".cache", "managed-runtimes")),
);
const work = path.join(outputRoot, `.work-${target}`);
const runtime = path.join(work, "runtime");
const packageArchive = path.join(
  cache,
  `playwright-core-${lock.playwright.version}.tgz`,
);
await rm(work, { recursive: true, force: true });
await mkdir(path.join(runtime, "node_modules"), { recursive: true });
await downloadPinned({
  url: lock.playwright.packageUrl,
  destination: packageArchive,
  bytes: lock.playwright.packageBytes,
  digest: lock.playwright.packageSha256,
});

const packageStage = path.join(work, "package-stage");
await mkdir(packageStage, { recursive: true });
await run(
  "tar",
  [
    "-xzf",
    tarArgumentPath(packageArchive, work),
    "-C",
    tarArgumentPath(packageStage, work),
  ],
  { cwd: work },
);
await rename(
  path.join(packageStage, "package"),
  path.join(runtime, "node_modules", "playwright-core"),
);

const browsers = JSON.parse(
  await readFile(
    path.join(runtime, "node_modules", "playwright-core", "browsers.json"),
    "utf8",
  ),
);
for (const browserName of ["chromium", "chromium-headless-shell"]) {
  const browser = browsers.browsers.find((item) => item.name === browserName);
  if (
    !browser ||
    browser.revision !== lock.chromium.revision ||
    browser.browserVersion !== lock.chromium.version
  )
    throw new Error(`${browserName} does not match the pinned Chromium unit`);
}

const browserPath = path.join(runtime, "browsers");
await run(
  process.execPath,
  [
    path.join(runtime, "node_modules", "playwright-core", "cli.js"),
    "install",
    "chromium",
    "chromium-headless-shell",
  ],
  {
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: browserPath,
      PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: "120000",
      PLAYWRIGHT_SKIP_BROWSER_GC: "1",
    },
  },
);

await mkdir(path.join(runtime, "launcher"), { recursive: true });
await cp(
  path.join(inputRoot, "smoke.mjs"),
  path.join(runtime, "launcher", "smoke.mjs"),
);
await collectPortableHostFiles(runtime);
await writeCompliance(runtime, lock, target);

await run(
  process.execPath,
  [path.join(runtime, "launcher", "smoke.mjs"), runtime],
  {
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: browserPath,
    },
  },
);
await rm(path.join(runtime, ".smoke-home"), { recursive: true, force: true });
await rm(path.join(runtime, ".smoke-cache"), { recursive: true, force: true });
await materializeLinks(runtime);

const artifactName = `cantrip-playwright-${lock.bundleVersion}-${target}.zip`;
const artifactPath = path.join(outputRoot, artifactName);
await rm(artifactPath, { force: true });
await run(process.platform === "win32" ? "python" : "python3", [
  path.join(root, "managed_runtimes", "searxng", "tools", "archive_runtime.py"),
  runtime,
  artifactPath,
]);
const descriptor = {
  schemaVersion: 1,
  component: "playwright",
  version: lock.bundleVersion,
  platform: lock.targets[target].platform,
  architecture: lock.targets[target].architecture,
  archiveFormat: "zip",
  compressedBytes: (await stat(artifactPath)).size,
  extractedBytes: await extractedBytes(runtime),
  sha256: await sha256(artifactPath),
  licenseManifest: "licenses/manifest.json",
  sourceManifest: "source/manifest.json",
  fileName: artifactName,
  ...(lock.targets[target].minimumOs
    ? { minimumOs: lock.targets[target].minimumOs }
    : {}),
  ...(lock.targets[target].minimumKernel
    ? { minimumKernel: lock.targets[target].minimumKernel }
    : {}),
  ...(lock.targets[target].minimumLibc
    ? { minimumLibc: lock.targets[target].minimumLibc }
    : {}),
};
await writeFile(
  path.join(outputRoot, `${target}.descriptor.json`),
  `${JSON.stringify(descriptor, null, 2)}\n`,
);
await rm(work, { recursive: true, force: true });
console.log(JSON.stringify(descriptor, null, 2));

async function collectPortableHostFiles(runtimeRoot) {
  await mkdir(path.join(runtimeRoot, "fonts"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "fontconfig"), { recursive: true });
  await writeFile(
    path.join(runtimeRoot, "fontconfig", "fonts.conf"),
    '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>../fonts</dir><cachedir>../font-cache</cachedir></fontconfig>\n',
  );
  const fontCandidates =
    process.platform === "linux"
      ? [
          "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
          "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        ]
      : [];
  for (const source of fontCandidates) {
    if (await exists(source))
      await cp(source, path.join(runtimeRoot, "fonts", path.basename(source)));
  }
  await mkdir(path.join(runtimeRoot, "certificates"), { recursive: true });
  const caCandidates =
    process.platform === "win32"
      ? []
      : ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"];
  for (const source of caCandidates) {
    if (await exists(source)) {
      await cp(source, path.join(runtimeRoot, "certificates", "ca-bundle.crt"));
      break;
    }
  }
  const caBundle = path.join(runtimeRoot, "certificates", "ca-bundle.crt");
  if (!(await exists(caBundle)))
    await writeFile(caBundle, `${rootCertificates.join("\n")}\n`);
  if (process.platform !== "linux") return;

  const libraryRoot = path.join(runtimeRoot, "libraries");
  const licenseRoot = path.join(runtimeRoot, "licenses", "linux-packages");
  await mkdir(libraryRoot, { recursive: true });
  await mkdir(licenseRoot, { recursive: true });
  const executables = await findFiles(
    path.join(runtimeRoot, "browsers"),
    (name) =>
      ["chrome", "headless_shell", "chrome-headless-shell"].includes(name),
  );
  const libraries = new Set();
  for (const executable of executables) {
    const { stdout } = await execFileAsync("ldd", [executable], {
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const line of stdout.split(/\r?\n/u)) {
      const match = line.match(/(?:=>\s*)?(\/[^\s]+)\s+\(0x/u);
      if (match) libraries.add(match[1]);
    }
  }
  const packages = new Set();
  for (const source of [...libraries].sort()) {
    const destination = path.join(libraryRoot, path.basename(source));
    if (!(await exists(destination))) await cp(source, destination);
    try {
      const { stdout } = await execFileAsync("dpkg-query", ["-S", source]);
      packages.add(stdout.split(":", 1)[0]);
    } catch {}
  }
  for (const packageName of [...packages].sort()) {
    const source = path.join("/usr/share/doc", packageName, "copyright");
    if (await exists(source))
      await cp(source, path.join(licenseRoot, `${packageName}.txt`));
  }
}

async function writeCompliance(runtimeRoot, runtimeLock, runtimeTarget) {
  const playwrightRoot = path.join(
    runtimeRoot,
    "node_modules",
    "playwright-core",
  );
  const licenseFiles = [];
  for (const name of ["LICENSE", "NOTICE", "ThirdPartyNotices.txt"]) {
    const source = path.join(playwrightRoot, name);
    if (await exists(source))
      licenseFiles.push(path.relative(runtimeRoot, source));
  }
  const linuxLicenseFiles = await findFiles(
    path.join(runtimeRoot, "licenses", "linux-packages"),
    () => true,
  );
  const packages = [
    {
      name: "playwright-core",
      version: runtimeLock.playwright.version,
      license: runtimeLock.playwright.license,
      licenseFiles,
    },
    {
      name: "Chromium",
      version: runtimeLock.chromium.version,
      revision: runtimeLock.chromium.revision,
      license: runtimeLock.chromium.license,
      licenseFiles: (
        await findFiles(path.join(runtimeRoot, "browsers"), (name) =>
          /^(license|credits)/iu.test(name),
        )
      ).map((value) => path.relative(runtimeRoot, value)),
    },
  ];
  if (linuxLicenseFiles.length > 0)
    packages.push({
      name: "Linux browser dependency closure",
      version: runtimeTarget,
      license: "SEE-FILES",
      licenseFiles: linuxLicenseFiles.map((value) =>
        path.relative(runtimeRoot, value),
      ),
    });
  await mkdir(path.join(runtimeRoot, "licenses"), { recursive: true });
  await writeFile(
    path.join(runtimeRoot, "licenses", "manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`,
  );
  await mkdir(path.join(runtimeRoot, "source"), { recursive: true });
  await writeFile(
    path.join(runtimeRoot, "source", "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        playwright: {
          repository: runtimeLock.playwright.repository,
          version: runtimeLock.playwright.version,
          packageUrl: runtimeLock.playwright.packageUrl,
          packageSha256: runtimeLock.playwright.packageSha256,
        },
        chromium: {
          source: runtimeLock.chromium.source,
          revision: runtimeLock.chromium.revision,
          version: runtimeLock.chromium.version,
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(runtimeRoot, "sbom.cdx.json"),
    `${JSON.stringify(
      {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        components: packages.slice(0, 2).map((item, index) => ({
          type: index === 0 ? "library" : "application",
          name: item.name,
          version: item.version,
          licenses: [{ license: { id: item.license } }],
        })),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(runtimeRoot, "build-info.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        component: "playwright",
        version: runtimeLock.bundleVersion,
        target: runtimeTarget,
        playwrightVersion: runtimeLock.playwright.version,
        chromiumRevision: runtimeLock.chromium.revision,
        browserArchitecture:
          runtimeLock.targets[runtimeTarget].browserArchitecture,
      },
      null,
      2,
    )}\n`,
  );
}

async function findFiles(directory, predicate) {
  if (!(await exists(directory))) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...(await findFiles(candidate, predicate)));
    else if (entry.isFile() && predicate(entry.name)) files.push(candidate);
  }
  return files;
}

async function exists(value) {
  try {
    await stat(value);
    return true;
  } catch {
    return false;
  }
}

async function materializeLinks(rootDirectory) {
  const resolvedRoot = await realpath(rootDirectory);
  const inodes = new Set();
  await visit(rootDirectory);
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) {
        const resolved = await realpath(candidate);
        const relation = path.relative(resolvedRoot, resolved);
        if (relation.startsWith("..") || path.isAbsolute(relation))
          throw new Error(`runtime symlink escapes the artifact: ${candidate}`);
        const targetMetadata = await stat(resolved);
        await rm(candidate, { recursive: true, force: true });
        await cp(resolved, candidate, {
          dereference: true,
          recursive: targetMetadata.isDirectory(),
        });
      } else if (metadata.isDirectory()) {
        await visit(candidate);
      } else if (metadata.isFile() && metadata.nlink > 1) {
        const key = `${metadata.dev}:${metadata.ino}`;
        if (inodes.has(key)) {
          const replacement = `${candidate}.materialized-${randomBytes(6).toString("hex")}`;
          await cp(candidate, replacement);
          await rm(candidate, { force: true });
          await rename(replacement, candidate);
        } else inodes.add(key);
      }
    }
  }
}
