ARG EXECUTOR_RUNTIME_STAGE=compiler
FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS process-owner
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY cantrip_os/packages/executor/file-helper/process-owner.c ./
RUN mkdir /out \
    && cc -std=c11 -Os -Wall -Wextra -Werror process-owner.c -o /out/process-owner

FROM rust:1.95.0-trixie@sha256:f49565f188ee00bc2a18dd418183f2c5f23ef7d6e691890517ed341a598f67c3 AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs git clang cmake pkg-config libssl-dev libcap-dev libseccomp-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /source

# Both helpers run as the existing guest workspace account. Reuse the
# worker's filesystem and definitions code in the guest entry points.
FROM toolchain AS native-helpers
ARG CARGO_BUILD_JOBS=6
RUN --mount=type=bind,source=.,target=/source,readonly \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/target,sharing=locked \
    CANTRIP_VERSION_PATCH=0 CARGO_TARGET_DIR=/target CARGO_INCREMENTAL=0 \
    CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS \
    cargo build --locked --release -p cantrip-worker \
      --features guest-run-definitions,guest-files \
      --bin cantrip-os-run-definitions --bin cantrip-os-files \
    && install -D /target/release/cantrip-os-run-definitions /out/cantrip-os-run-definitions \
    && install -D /target/release/cantrip-os-files /out/cantrip-os-files

# Build the pinned executor and its sandbox helper with reviewed patches.
FROM toolchain AS compiler
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

FROM ${EXECUTOR_RUNTIME_STAGE} AS executor-runtime

FROM scratch AS runtime
COPY --from=executor-runtime /executor/ /

FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS package
COPY --from=executor-runtime /executor/ /runtime/
COPY cantrip_os/packages/executor/ /package/
COPY --from=process-owner /out/process-owner /package/root/usr/lib/cantrip-os-executor/process-owner
COPY --from=native-helpers /out/cantrip-os-run-definitions /out/cantrip-os-files /package/root/usr/lib/cantrip-os-executor/
RUN /package/build.sh /runtime /out

FROM scratch AS deb
COPY --from=package /out/ /
