FROM node:24-bookworm AS build

ARG TARGETARCH
WORKDIR /workspace

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY cantrip_server ./cantrip_server
COPY deploy ./deploy
COPY patches ./patches
COPY scripts ./scripts

RUN corepack pnpm install --frozen-lockfile
RUN case "$TARGETARCH" in \
      amd64) cantrip_target=linux-x64 ;; \
      arm64) cantrip_target=linux-arm64 ;; \
      *) echo "Unsupported server architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && corepack pnpm package:server --target "$cantrip_target" \
    && mkdir /out \
    && cp -a "artifacts/cantrip-server-$cantrip_target/." /out/

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
