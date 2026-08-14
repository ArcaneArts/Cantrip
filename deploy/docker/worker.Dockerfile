FROM node:24-bookworm AS build

ARG TARGETARCH
ARG CANTRIP_VERSION_PATCH
ARG RUST_TOOLCHAIN=1.95.0
ENV CANTRIP_VERSION_PATCH=${CANTRIP_VERSION_PATCH} \
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
      libkrb5-dev \
      libssl-dev \
      pkg-config \
      python3 \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain "$RUST_TOOLCHAIN" \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

COPY . .

RUN test -n "$CANTRIP_VERSION_PATCH" \
    || (echo "CANTRIP_VERSION_PATCH is required for Docker builds." >&2; exit 1)
RUN corepack pnpm install --frozen-lockfile
RUN case "$TARGETARCH" in \
      amd64) cantrip_target=linux-x64 ;; \
      arm64) cantrip_target=linux-arm64 ;; \
      *) echo "Unsupported worker architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && corepack pnpm package:worker --target "$cantrip_target" \
    && mkdir /out \
    && cp -a "artifacts/cantrip-worker-$cantrip_target/." /out/

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      bash \
      ca-certificates \
      git \
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
    HOME=/var/lib/cantrip-worker \
    NODE_ENV=production
VOLUME ["/var/lib/cantrip-worker"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/cantrip/start.sh"]
