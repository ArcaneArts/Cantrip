import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  CODE_MANIFEST_NAME,
  assertHostTarget,
  createBuildManifest,
  getBuildIdentity,
  normalizeTarget,
  verifyBuild,
} from "./build-lib.mjs";
import {
  codeBuildRoot,
  codeCacheRoot,
  codeRoot,
  copyDirectory,
  exists,
  extensionsRoot,
  parseArgs,
  readJson,
  run,
  upstreamConfigPath,
  upstreamRoot,
  writeJson,
} from "./lib.mjs";
import { readPatchSeries } from "./patches.mjs";
import { ensureBuildNode, environmentForBuildNode } from "./toolchain.mjs";

const args = parseArgs(process.argv.slice(2));
const target = normalizeTarget(args.optional("target"));
assertHostTarget(target);
const identity = await getBuildIdentity(target);

if (!args.flag("force")) {
  try {
    await verifyBuild(identity, { full: false });
    console.log(
      `Reusing Cantrip Code ${target.id} build ${identity.fingerprint.slice(0, 12)}`,
    );
    process.exit(0);
  } catch {
    // A missing, stale, or incomplete cache is rebuilt below.
  }
}

await run(process.execPath, [
  path.join(codeRoot, "..", "scripts", "cantrip-code", "verify-upstream.mjs"),
]);

const preparationRoot = path.join(
  codeBuildRoot,
  `${target.id}-${identity.fingerprint}`,
);
const source = path.join(preparationRoot, "source");
const gulpOutput = path.join(
  preparationRoot,
  `vscode-reh-web-${target.platform}-${target.arch}`,
);
await rm(preparationRoot, { recursive: true, force: true });
await mkdir(preparationRoot, { recursive: true });

try {
  console.log(`Preparing pinned Cantrip Code source for ${target.id}...`);
  await copyDirectory(upstreamRoot, source);

  const productPath = path.join(source, "product.json");
  const product = JSON.parse(await readFile(productPath, "utf8"));
  const overrides = await readJson(
    path.join(codeRoot, "resources", "product.overrides.json"),
  );
  await writeJson(productPath, { ...product, ...overrides });

  if (await exists(extensionsRoot)) {
    for (const entry of await readdir(extensionsRoot, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      await copyDirectory(
        path.join(extensionsRoot, entry.name),
        path.join(source, "extensions", entry.name),
      );
    }
  }

  for (const item of await readPatchSeries()) {
    await run(
      "git",
      [
        "apply",
        "--no-index",
        "--unsafe-paths",
        "--ignore-space-change",
        item.patchPath,
      ],
      {
        cwd: source,
        // The prepared source lives below Cantrip's worktree. Stop Git from
        // discovering that parent repository, otherwise it filters every
        // source-relative patch as outside the current repository prefix and
        // exits successfully after silently skipping it.
        env: { GIT_CEILING_DIRECTORIES: path.dirname(source) },
      },
    );
    console.log(`Applied ${path.basename(item.patchPath)}`);
  }

  const upstream = await readJson(upstreamConfigPath);
  const toolchain = await ensureBuildNode(target);
  const buildEnvironment = environmentForBuildNode(toolchain, {
    BUILD_SOURCEVERSION: upstream.openvscodeServerCommit,
    npm_config_cache: path.join(codeCacheRoot, "npm"),
  });
  if (target.platform === "darwin") {
    // The fmt version pinned by @vscode/spdlog uses a consteval path rejected
    // by Apple Clang shipped with Xcode 26. Disabling that optional compile-time
    // optimization preserves behavior and keeps the pinned native dependency
    // buildable until upstream advances it.
    const compatibilityFlags = "-DFMT_CONSTEVAL=";
    buildEnvironment.CXXFLAGS = [process.env.CXXFLAGS, compatibilityFlags]
      .filter(Boolean)
      .join(" ");
    buildEnvironment.VSCODE_REMOTE_CXXFLAGS = [
      process.env.VSCODE_REMOTE_CXXFLAGS,
      compatibilityFlags,
    ]
      .filter(Boolean)
      .join(" ");
  }
  console.log("Installing pinned OpenVSCode build dependencies...");
  await run(toolchain.node, [toolchain.npmCli, "ci"], {
    cwd: source,
    env: buildEnvironment,
  });

  const tasks = [
    "compile-build-without-mangling",
    "extensions-ci",
    "minify-vscode-reh-web",
    `vscode-reh-web-${target.platform}-${target.arch}-min-ci`,
  ];
  for (const task of tasks) {
    console.log(`Building ${task}...`);
    await run(toolchain.node, [toolchain.npmCli, "run", "gulp", task], {
      cwd: source,
      env: buildEnvironment,
    });
  }
  if (!(await exists(gulpOutput))) {
    throw new Error(`OpenVSCode build did not create ${gulpOutput}`);
  }

  const stagedCache = `${identity.cacheDirectory}.staging-${process.pid}`;
  await rm(stagedCache, { recursive: true, force: true });
  await mkdir(stagedCache, { recursive: true });
  await rename(gulpOutput, path.join(stagedCache, "distribution"));
  const stagedIdentity = {
    ...identity,
    cacheDirectory: stagedCache,
    distributionDirectory: path.join(stagedCache, "distribution"),
    manifestPath: path.join(stagedCache, CODE_MANIFEST_NAME),
  };

  for (const legalFile of [
    "LICENSE.txt",
    "ThirdPartyNotices.txt",
    "cglicenses.json",
  ]) {
    await cp(
      path.join(upstreamRoot, legalFile),
      path.join(stagedIdentity.distributionDirectory, legalFile),
    );
  }
  const manifest = await createBuildManifest(stagedIdentity);
  await writeFile(
    stagedIdentity.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await rm(identity.cacheDirectory, { recursive: true, force: true });
  await mkdir(path.dirname(identity.cacheDirectory), { recursive: true });
  await rename(stagedCache, identity.cacheDirectory);
  await verifyBuild(identity, { full: true });
  console.log(
    `Built Cantrip Code ${target.id} ${identity.fingerprint.slice(0, 12)} ` +
      `(${manifest.files.length} files)`,
  );
} finally {
  if (!args.flag("keep-prepared")) {
    await rm(preparationRoot, { recursive: true, force: true });
  } else {
    console.log(`Kept prepared source at ${preparationRoot}`);
  }
}
