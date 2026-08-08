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
