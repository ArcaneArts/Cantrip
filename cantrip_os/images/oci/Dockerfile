FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4
ENV DEBIAN_FRONTEND=noninteractive LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
COPY manifests/desktop.packages /tmp/desktop.packages
RUN apt-get update && xargs -r apt-get install -y --no-install-recommends < /tmp/desktop.packages \
    && apt-get install -y --no-install-recommends tigervnc-standalone-server novnc websockify tini \
    && rm -rf /var/lib/apt/lists/* /tmp/desktop.packages
COPY overlays/ /
COPY scripts/configure-system.sh /tmp/configure-system.sh
RUN sh /tmp/configure-system.sh && rm /tmp/configure-system.sh
COPY viewer/index.html /usr/share/novnc/index.html
COPY images/oci/start.sh /usr/local/sbin/cantrip-os-start
RUN chmod 0755 /usr/local/sbin/cantrip-os-start
ENV CANTRIP_OS_CONTAINER=1 DISPLAY=:0
EXPOSE 6080
VOLUME ["/home/cantrip"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/sbin/cantrip-os-start"]
