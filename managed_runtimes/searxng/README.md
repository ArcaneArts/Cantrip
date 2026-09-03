# Portable SearXNG runtime

This directory is the reproducible input to Cantrip's managed SearXNG
artifacts. `runtime.lock.json` pins the SearXNG and portable CPython inputs for
all six worker tuples. `requirements.lock` pins every Python dependency and
hash.

Build a native artifact on a matching host with:

```sh
pnpm managed-runtime:searxng:build -- --target linux-x64
```

The build downloads only the pinned inputs, verifies their byte count and
SHA-256 digest, installs wheels into the bundled interpreter, gathers matching
source distributions and license metadata, launches the artifact offline, and
writes an unsigned release descriptor. Release CI repeats a real-engine smoke,
signs each artifact record, and publishes the records inside the shared
twelve-artifact web-runtime manifest.

Production signing uses `CANTRIP_MANAGED_RUNTIME_SIGNING_KEY_BASE64`, an
Ed25519 PKCS#8 DER private key stored as a GitHub Actions secret. The matching
public key is a worker trust root and is never fetched from the release.
