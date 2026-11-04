# Bundle only shared application filesystem semantics. No worker orchestration,
# account encryption, model-provider credentials, or network listener is shipped.
FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS file-helper
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY cantrip_os/packages/executor/file-helper/package.json cantrip_os/packages/executor/file-helper/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
WORKDIR /source
COPY packages/protocol/src/ packages/protocol/src/
COPY packages/crypto/src/ packages/crypto/src/
COPY cantrip_worker/src/ cantrip_worker/src/
COPY cantrip_os/packages/executor/file-helper/ cantrip_os/packages/executor/file-helper/
RUN CANTRIP_OS_ESBUILD_MODULE=/build/node_modules/esbuild/lib/main.js \
    CANTRIP_OS_HELPER_NODE_PATH=/build/node_modules \
    node cantrip_os/packages/executor/file-helper/build.mjs /out/file-operations.mjs \
    && cc -std=c11 -Os -Wall -Wextra -Werror cantrip_os/packages/executor/file-helper/process-owner.c -o /out/process-owner \
    && cp /build/node_modules/zod/LICENSE /out/file-helper-zod-LICENSE \
    && cp /build/node_modules/dotenv/LICENSE /out/run-helper-dotenv-LICENSE \
    && cp /build/node_modules/smol-toml/LICENSE /out/run-helper-smol-toml-LICENSE

# Build only the pinned executor and its sandbox helper, using the same source
# verification and reviewed patch preparation as the worker runtime.
FROM rust:1.95.0-trixie@sha256:f49565f188ee00bc2a18dd418183f2c5f23ef7d6e691890517ed341a598f67c3 AS compiler
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs git clang cmake pkg-config libssl-dev libcap-dev libseccomp-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY scripts/cantrip-codex/ scripts/cantrip-codex/
COPY scripts/cantrip-skills.mjs scripts/cantrip-skills.mjs
COPY skill_templates/ skill_templates/
COPY cantrip_codex/ cantrip_codex/
ARG CARGO_BUILD_JOBS=6
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/source/cantrip_codex/.build,sharing=locked \
    CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS node scripts/cantrip-codex/build.mjs --executor-only \
    && mkdir /executor \
    && binary_arch=$(node -p process.arch) \
    && cp -a "cantrip_codex/.build/linux-$binary_arch/executor/bundle/." /executor/

FROM scratch AS runtime
COPY --from=compiler /executor/ /

FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS package
COPY --from=compiler /executor/ /runtime/
COPY cantrip_os/packages/executor/ /package/
COPY --from=file-helper /out/file-operations.mjs /out/run-definitions.mjs /out/run-plan.mjs /package/root/usr/lib/cantrip-os-executor/
COPY --from=file-helper /out/process-owner /package/root/usr/lib/cantrip-os-executor/process-owner
COPY --from=file-helper /out/file-helper-zod-LICENSE /package/root/usr/share/doc/cantrip-os-executor/file-helper-zod-LICENSE
COPY --from=file-helper /out/run-helper-dotenv-LICENSE /out/run-helper-smol-toml-LICENSE /package/root/usr/share/doc/cantrip-os-executor/
RUN /package/build.sh /runtime /out

FROM scratch AS deb
COPY --from=package /out/ /
