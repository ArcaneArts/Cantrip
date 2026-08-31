FROM node:24-bookworm AS build

ARG TARGETARCH
ARG CANTRIP_VERSION_PATCH
ENV CANTRIP_VERSION_PATCH=${CANTRIP_VERSION_PATCH}
WORKDIR /workspace

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY version.json ./
COPY packages/logging ./packages/logging
COPY packages/protocol ./packages/protocol
COPY packages/version ./packages/version
COPY policy_templates ./policy_templates
COPY cantrip_server ./cantrip_server
COPY deploy ./deploy
COPY patches ./patches
COPY scripts ./scripts

RUN test -n "$CANTRIP_VERSION_PATCH" \
    || (echo "CANTRIP_VERSION_PATCH is required for Docker builds." >&2; exit 1)
RUN corepack pnpm install --frozen-lockfile
RUN case "$TARGETARCH" in \
      amd64) cantrip_target=linux-x64 ;; \
      arm64) cantrip_target=linux-arm64 ;; \
      *) echo "Unsupported server architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && corepack pnpm package:server --target "$cantrip_target" \
    && mkdir /out \
    && cp -a "artifacts/cantrip-server-$cantrip_target/." /out/

# `pnpm deploy:server` exports this target as a native Linux deployment tree.
# Keeping it separate from the runtime image lets systemd run the exact same
# self-contained artifact without requiring Docker on the production host.
FROM scratch AS distribution

COPY --from=build /out/ /

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 cantrip \
    && useradd --uid 10001 --gid cantrip --home-dir /var/lib/cantrip --create-home cantrip \
    && mkdir -p /opt/cantrip /var/lib/cantrip \
    && chown -R cantrip:cantrip /opt/cantrip /var/lib/cantrip

COPY --from=build --chown=cantrip:cantrip /out/ /opt/cantrip/

USER cantrip
WORKDIR /opt/cantrip
ENV CANTRIP_DATA_DIR=/var/lib/cantrip \
    NODE_ENV=production
VOLUME ["/var/lib/cantrip"]
EXPOSE 4310 4311
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/cantrip/start.sh"]
