FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS workspace-package
COPY packages/workspaces/ /package/
RUN /package/build.sh /out

FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4
ENV DEBIAN_FRONTEND=noninteractive LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
COPY manifests/desktop.packages /tmp/desktop.packages
RUN apt-get update && xargs -r apt-get install -y --no-install-recommends < /tmp/desktop.packages \
    && apt-get install -y --no-install-recommends tigervnc-standalone-server novnc websockify tini \
    && rm -rf /var/lib/apt/lists/* /tmp/desktop.packages /usr/share/icewm/themes/*
COPY overlays/ /
ARG CANTRIP_OS_WORKSPACES=1
ARG CANTRIP_OS_EXECUTOR=0
COPY --from=workspace-package /out/ /tmp/cantrip-packages/
COPY --from=executor / /tmp/cantrip-executor/
RUN if [ "$CANTRIP_OS_WORKSPACES" = 1 ]; then \
      apt-get update && apt-get install -y --no-install-recommends /tmp/cantrip-packages/*.deb; \
    elif [ "$CANTRIP_OS_WORKSPACES" != 0 ]; then exit 1; fi \
    && rm -rf /tmp/cantrip-packages /var/lib/apt/lists/*
RUN if [ "$CANTRIP_OS_EXECUTOR" = 1 ]; then \
      apt-get update && apt-get install -y --no-install-recommends /tmp/cantrip-executor/*.deb; \
    elif [ "$CANTRIP_OS_EXECUTOR" != 0 ]; then exit 1; fi \
    && rm -rf /tmp/cantrip-executor /var/lib/apt/lists/*
COPY scripts/configure-system.sh /tmp/configure-system.sh
RUN sh /tmp/configure-system.sh && rm /tmp/configure-system.sh
COPY viewer/ /usr/share/novnc/
COPY images/oci/start.sh /usr/local/sbin/cantrip-os-start
RUN chmod 0755 /usr/local/sbin/cantrip-os-start
ENV CANTRIP_OS_CONTAINER=1 DISPLAY=:0
EXPOSE 6080 5900 6081
VOLUME ["/home/cantrip", "/var/lib/cantrip-os-workspaces", "/var/lib/cantrip-os-executor"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/sbin/cantrip-os-start"]
