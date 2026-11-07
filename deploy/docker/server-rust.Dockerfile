# Node is build tooling only. No Node runtime is copied to the distribution or
# final image; the unchanged worker continues to use its own image/runtime.
FROM node:24.22.1-bookworm-slim AS node-build-tool

FROM rust:1.93.0-bookworm AS build

ARG TARGETARCH
ARG CANTRIP_VERSION_PATCH
ENV CANTRIP_VERSION_PATCH=${CANTRIP_VERSION_PATCH} \
    CARGO_INCREMENTAL=0 \
    CARGO_BUILD_JOBS=2 \
    CARGO_PROFILE_RELEASE_DEBUG=0
WORKDIR /workspace

COPY --from=node-build-tool /usr/local/bin/node /usr/local/bin/node
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libssl-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY version.json ./
COPY cantrip_server_rs ./cantrip_server_rs
COPY cantrip_server/drizzle ./cantrip_server/drizzle
COPY scripts/version.mjs ./scripts/
COPY scripts/server-rust/build.mjs scripts/server-rust/build-version.mjs \
    scripts/server-rust/cargo.mjs ./scripts/server-rust/
COPY policy_templates ./policy_templates
COPY deploy/server.env.example ./deploy/server.env.example
COPY deploy/server-rust.README.md ./deploy/server-rust.README.md

# Reuse one build cache per actual Linux architecture. Incremental compilation
# stays disabled; worktree/PR names never create additional cache directories.
RUN --mount=type=cache,id=cantrip-server-rust-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=cantrip-server-rust-target-${TARGETARCH},target=/native-target,sharing=locked \
    CARGO_TARGET_DIR=/native-target node --input-type=module -e \
    'import {cp} from "node:fs/promises"; import {buildRustServer} from "./scripts/server-rust/build.mjs"; await cp(await buildRustServer({release:true}), "/cantrip-server");'

FROM postgres:18-bookworm AS package

ARG TARGETARCH
ARG CANTRIP_VERSION_PATCH
ENV CANTRIP_VERSION_PATCH=${CANTRIP_VERSION_PATCH}
WORKDIR /workspace
COPY --from=node-build-tool /usr/local/bin/node /usr/local/bin/node
COPY --from=build /cantrip-server /cantrip-server
COPY scripts/version.mjs scripts/native-target.mjs scripts/package-server-rust.mjs ./scripts/
COPY scripts/server-rust/build.mjs scripts/server-rust/build-version.mjs \
    scripts/server-rust/cargo.mjs scripts/server-rust/postgres-assets.mjs ./scripts/server-rust/
COPY --from=build /workspace/version.json ./version.json
COPY --from=build /workspace/policy_templates ./policy_templates
COPY --from=build /workspace/deploy/server.env.example ./deploy/server.env.example
COPY --from=build /workspace/deploy/server-rust.README.md ./deploy/server-rust.README.md
RUN case "$TARGETARCH" in \
      amd64) cantrip_target=linux-x64 ;; \
      arm64) cantrip_target=linux-arm64 ;; \
    esac \
    && node scripts/package-server-rust.mjs \
      --target "$cantrip_target" --binary /cantrip-server --output /out \
      --postgres-bin /usr/lib/postgresql/18/bin \
      --postgres-share /usr/share/postgresql/18 \
      --postgres-lib /usr/lib/postgresql/18/lib \
      --notices-dir /usr/share/doc

# Compatible with Winterhold's native distribution export and systemd entry
# points: start.sh, migrate.sh, and a separately writable profile directory.
FROM scratch AS distribution
COPY --from=package /out/ /

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 cantrip \
    && useradd --uid 10001 --gid cantrip --home-dir /var/lib/cantrip --create-home cantrip \
    && mkdir -p /opt/cantrip \
    && chown cantrip:cantrip /opt/cantrip
COPY --from=package --chown=cantrip:cantrip /out/ /opt/cantrip/
USER cantrip
WORKDIR /opt/cantrip
ENV CANTRIP_DATA_DIR=/var/lib/cantrip NODE_ENV=production
VOLUME ["/var/lib/cantrip"]
EXPOSE 4310
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
    CMD curl --fail --silent --show-error "http://127.0.0.1:${CANTRIP_SERVER_PORT:-4310}/readyz" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/cantrip/start.sh"]
