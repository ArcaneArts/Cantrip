# Managed Playwright runtime

This directory pins the `playwright-core`, Chromium, and headless Chromium unit
used by Cantrip web research. Release CI builds every supported host tuple
natively, validates an isolated sandboxed browser session, inventories bundled
licenses and Linux runtime dependencies, and emits link-free deterministic ZIP
artifacts for the worker's signed managed-runtime installer.

Build the current host artifact with:

```sh
pnpm managed-runtime:playwright:build
```

The worker never runs this build path. The managed web-research runtime never
consults a system browser or Playwright cache; user-created Browser tabs use a
separate runtime path.
