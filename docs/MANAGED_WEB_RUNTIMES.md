# Managed web runtime operations

Cantrip workers install the SearXNG and Playwright/Chromium runtimes used for
managed web research from the immutable, signed managed-web-runtime release
channel. That managed web-research path never discovers or invokes a system
Python, SearXNG, Node, Playwright, Chrome, Edge, or Chromium installation.
User-created Browser tabs are a separate worker feature and may use the system
Chromium-family browser documented in the [root README](../README.md).

## Release procedure

1. Update both runtime locks as one compatibility unit. Keep their
   `bundleVersion` values identical and pin every URL, byte count, digest,
   source revision, and dependency hash.
2. Open a pull request that touches the runtime inputs. The **Managed web
   runtimes** workflow must build and smoke-test SearXNG and Playwright on all
   six native targets. Publication is forbidden if any matrix job fails.
3. After the change is merged, dispatch `.github/workflows/managed-web-runtimes.yml`
   on `main` with `publish=true`. The signing key and key ID come only from the
   protected repository secret and variable.
4. Verify the resulting immutable `web-runtime-<bundleVersion>` release has one
   shared `manifest.json` containing twelve individually signed artifact
   records, the twelve artifacts, twelve descriptors, and corresponding
   source/license inventories. The manifest itself has no top-level signature.
   Never replace assets on an existing tag; publish a new bundle version.
5. Start a clean worker for each supported host family and observe both
   components reach `ready` from the published manifest before treating the
   release as promoted.

The current baselines are declared in the locks. SearXNG supports macOS 11,
Windows 10, and Linux kernel 4.18 with glibc 2.17. Playwright/Chromium supports
macOS 14, Windows 10 x64, Windows 11 ARM64 through explicit x64 emulation, and
Linux kernel 5.15 with glibc 2.35. Chromium sandbox availability is mandatory;
an unsupported host is reported as unsupported and is never repaired by
installing host packages or adding `--no-sandbox`.

## Worker operations

Settings → Workers → Managed web runtimes presents immutable status and
bounded diagnostics. Operators can check for an update, retry, reinstall the
current signed artifact, clear disposable cache data, or clear persistent
Cantrip Browser profiles. Profile clearing requires confirmation and removes
saved browser cookies and sessions. Reinstall and cache cleanup wait for or
reject active work rather than interrupting an agent call.

The installer retains only the current and previous verified artifacts. Partial
downloads and staging directories older than 24 hours are disposable. Static
fetches allow five redirects, 5 MB compressed and 10 MB expanded bodies.
Interactive browsing allows four contexts, sixteen queued waiters, one
persistent browser process, 100 element references per snapshot, and a
15-minute abandoned-session lifetime. These are implementation ceilings, not
capacity targets.

## Licensing and source

SearXNG is AGPL-3.0-or-later; every SearXNG artifact must include its exact
corresponding source, Cantrip patches, locked build inputs, notices, license
manifest, and SBOM. Playwright is Apache-2.0 and Chromium is BSD-3-Clause with
third-party notices; their artifact must include the exact Playwright source
metadata, Chromium revision, notices, Linux dependency licenses, and SBOM.
Missing compliance inventory is a release failure.

## Incident rollback

Stop publication immediately when signature, digest, inventory, sandbox, or
clean-host smoke checks fail. Do not modify the failed release. Workers keep
the current verified runtime when candidate installation fails and can
atomically roll back to the retained previous version after a promoted runtime
repeatedly fails. For a channel-wide incident, publish a new bundle version
whose locks point to the last known-good unit, then run the complete matrix and
normal signed publication flow. Preserve the failed immutable release and CI
evidence for investigation; rotate the signing key and ship its public key in a
normal application release if key compromise is suspected.

Diagnostics and logs must contain only component/version, status, duration,
byte/result counts, and coarse failure categories. Queries, URLs, page bodies,
snapshots, form values, cookies, profiles, runtime paths, and process IDs must
not cross the worker boundary or enter plaintext logs.
