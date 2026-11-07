# Local deployment rehearsal only. No host filesystem or Docker socket is mounted.
FROM ubuntu:24.04
ARG TARGETARCH
ENV container=docker
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      systemd systemd-sysv dbus caddy curl ca-certificates procps \
    && rm -rf /var/lib/apt/lists/* \
    && systemctl mask getty.target console-getty.service systemd-logind.service
# Docker Desktop's x64 systemd emulation cannot launch services. On an ARM64
# fixture host, supply the x64 ELF loader/glibc so native systemd can execute the
# real x64 distribution through Docker's binfmt handler. No server files change.
RUN if [ "$TARGETARCH" = arm64 ]; then \
      dpkg --add-architecture amd64 \
      && sed -i '/^Types: deb/a Architectures: arm64' /etc/apt/sources.list.d/ubuntu.sources \
      && printf 'deb [arch=amd64] http://archive.ubuntu.com/ubuntu noble main\ndeb [arch=amd64] http://archive.ubuntu.com/ubuntu noble-updates main\ndeb [arch=amd64] http://security.ubuntu.com/ubuntu noble-security main\n' > /etc/apt/sources.list.d/amd64.list \
      && apt-get update \
      && apt-get install --yes --no-install-recommends libc6:amd64 libstdc++6:amd64 \
      && rm -rf /var/lib/apt/lists/*; \
    fi
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
