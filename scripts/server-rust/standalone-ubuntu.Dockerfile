# Local ABI/service-user rehearsal of the exported standalone distribution.
FROM ubuntu:24.04
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 cantrip \
    && useradd --uid 10001 --gid cantrip --home-dir /var/lib/cantrip --create-home cantrip
# Keep executable resources root-owned, as in the systemd release directory.
COPY . /opt/cantrip/
USER cantrip
WORKDIR /opt/cantrip
ENV CANTRIP_DATA_DIR=/var/lib/cantrip NODE_ENV=production
VOLUME ["/var/lib/cantrip"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/cantrip/start.sh"]
