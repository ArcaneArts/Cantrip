# Managed Chromium runtime

This directory pins the Chromium and headless Chromium builds used by Cantrip
web research. Playwright runs in release build staging to download the pinned
browsers and exercise a sandboxed session. The ZIP contains the browsers,
platform support files, licenses, and provenance. The Rust worker launches
headless Chromium directly through CDP.

Build the current host artifact with:

```sh
pnpm managed-runtime:playwright:build
```

The managed web runtime uses its own installed browser and worker-owned profile.
User-created Browser tabs use a separate runtime path. The release and wire
component retain the name `playwright` for existing profiles.

The Rust worker can reopen the existing signed release. Once a Chromium-only
release is signed and published, operators can select it through
`CANTRIP_MANAGED_RUNTIME_MANIFEST_URL`. Change the worker's default manifest URL
after the new signed manifest is available.
