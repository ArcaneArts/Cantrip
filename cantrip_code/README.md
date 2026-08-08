# Cantrip Code

Cantrip Code is Cantrip's pinned, browser-native Code OSS distribution. The
real OpenVSCode Server source is committed under [`upstream/`](upstream/), while
Cantrip-owned extensions, resources, patch metadata, and build tooling live
beside that immutable snapshot.

The current source is recorded in [`upstream.json`](upstream.json). It never
advances implicitly and a running worker never downloads or updates the editor.
An upstream change is produced explicitly with the repository scripts, reviewed
as a Cantrip pull request, compiled during worker packaging, and released as an
immutable part of that worker.

## Source maintenance

```bash
pnpm code:verify
pnpm code:divergence
pnpm code:fetch
```

`code:fetch` downloads the currently pinned snapshot to the ignored
`.cantrip-code/` workspace without modifying tracked source. To deliberately
advance the snapshot, provide every new identity field and confirmation:

```bash
pnpm code:merge -- \
  --version 1.109.5 \
  --ref openvscode-server-v1.109.5 \
  --sha 4ffe2270acdf711bbefecc3e8c79f4b3631640e5 \
  --vscode-sha 072586267e68ece9a47aa43f8c108e0dcbf44622 \
  --confirm
```

The merge command replaces only `cantrip_code/upstream/`, writes the pinned
metadata and source manifest, and leaves all Cantrip-owned paths intact. Direct
patches are applied later to a prepared build tree, never destructively to the
committed pristine upstream snapshot.

## Build and development

Cantrip compiles OpenVSCode's browser server for the current operating system
and architecture. The cache key includes the pinned source manifest, patch
series, product overrides, Cantrip-owned extensions, and native target.

```bash
pnpm code:build
pnpm code:ready
pnpm code:verify
pnpm code:dev
pnpm code:clean
```

`code:build` uses upstream's locked npm dependency graph, non-mangled PR
compiler, minifier, and native `vscode-reh-web-<platform>-<arch>-min-ci`
packager. It writes only ignored build and cache directories. A valid build is
reused until an input changes. Git worktrees share the repository-level
`.cantrip-code/cache` so sequential PR cycles reuse the same immutable artifact;
set `CANTRIP_CODE_CACHE_DIR` to place this build cache on another volume.
`code:verify` hashes the complete cached distribution against its manifest;
`code:ready` is the intentionally cheaper startup check. `code:dev` hosts the
cached editor on `127.0.0.1:9888` with isolated development state.

Normal `pnpm dev` and `pnpm devtop` never begin the large editor build. They
stop with a `pnpm code:build` instruction when the required cache is absent or
stale. Worker and desktop packaging do build (or reuse) the editor and embed
that exact immutable distribution.

The editor build bootstraps the exact Node release pinned in upstream's
`.nvmrc`, verifies it against Node's published SHA-256 inventory, and caches it
as a build-only toolchain. This keeps OpenVSCode's native dependency compiler
independent from the Node version running Cantrip or pnpm.

See [`../docs/CODE.md`](../docs/CODE.md) for the complete architecture and
release policy.

## Licensing

OpenVSCode Server and Code OSS are distributed under the MIT License. The
upstream license, third-party attribution inventory, and dependency license
data remain in the committed snapshot:

- [`upstream/LICENSE.txt`](upstream/LICENSE.txt)
- [`upstream/ThirdPartyNotices.txt`](upstream/ThirdPartyNotices.txt)
- [`upstream/cglicenses.json`](upstream/cglicenses.json)

Cantrip release packaging must preserve those files alongside the editor.
