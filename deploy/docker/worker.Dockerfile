FROM node:24-bookworm AS build

ARG RUST_TOOLCHAIN=1.95.0
ENV CARGO_BUILD_JOBS=2 \
    CARGO_INCREMENTAL=0 \
    CARGO_PROFILE_RELEASE_DEBUG=0 \
    CARGO_TARGET_DIR=/native-target \
    CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:$PATH
WORKDIR /workspace

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      build-essential \
      ca-certificates \
      clang \
      cmake \
      curl \
      git \
      libcap-dev \
      libkrb5-dev \
      libssl-dev \
      pkg-config \
      python3 \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain "$RUST_TOOLCHAIN" \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
ARG CANTRIP_VERSION_PATCH
ENV CANTRIP_VERSION_PATCH=${CANTRIP_VERSION_PATCH}

COPY . .

RUN test -n "$CANTRIP_VERSION_PATCH" \
    || (echo "CANTRIP_VERSION_PATCH is required for Docker builds." >&2; exit 1)
RUN --mount=type=cache,id=cantrip-worker-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=cantrip-worker-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=cantrip-worker-target-${TARGETARCH},target=/native-target,sharing=locked \
    case "$TARGETARCH" in \
      amd64) cantrip_target=linux-x64 ;; \
      arm64) cantrip_target=linux-arm64 ;; \
      *) echo "Unsupported worker architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && node scripts/package-distributions.mjs worker --target "$cantrip_target" \
    && mv "artifacts/cantrip-worker-$cantrip_target" /out \
    && rm -rf cantrip_codex/.build

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      bash \
      ca-certificates \
      git \
      libcap2 \
      openssh-client \
      tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 cantrip \
    && useradd --uid 10001 --gid cantrip --home-dir /var/lib/cantrip-worker --create-home cantrip \
    && mkdir -p /opt/cantrip /var/lib/cantrip-worker/repositories \
    && chown -R cantrip:cantrip /opt/cantrip /var/lib/cantrip-worker

COPY --from=build --chown=cantrip:cantrip /out/ /opt/cantrip/

USER cantrip
WORKDIR /opt/cantrip
ENV CANTRIP_WORKER_DATA_DIR=/var/lib/cantrip-worker \
    HOME=/var/lib/cantrip-worker
VOLUME ["/var/lib/cantrip-worker"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/cantrip/start.sh"]
