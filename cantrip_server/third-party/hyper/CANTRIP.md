# HTTP status reason preservation

This is hyper 1.12.0 from the crates.io registry, under the upstream MIT
license. `upstream-sha256.json` records every copied upstream file before the
patch. No upstream runtime file is changed except `src/proto/h1/role.rs`.

The HTTP/1 response parser now retains raw reason-phrase bytes in the existing
`ReasonPhrase` extension. Upstream uses `httparse::Response.reason`, which
intentionally becomes an empty string for non-UTF8 status text. The bytes are
otherwise accepted, but the native public catalog client loses the error
message. Cantrip's Node Fetch implementation decodes those bytes as UTF8 with
replacement. The client applies that same decoding to the preserved extension.

The real loopback HTTP differential suite
`scripts/server-rust/openrouter-http-compatibility.mjs` includes custom, empty
and non-ASCII status reasons. The failing pre-patch receipt is retained in the
settings milestone's QA evidence. No Node helper is used by the native client.
