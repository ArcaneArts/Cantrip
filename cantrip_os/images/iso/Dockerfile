FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    live-build debootstrap ca-certificates xorriso squashfs-tools dosfstools \
    mtools grub-pc-bin grub-efi-amd64-bin syslinux-common isolinux \
    && rm -rf /var/lib/apt/lists/*
COPY manifests/ /source/manifests/
COPY overlays/ /source/overlays/
COPY images/iso/ /source/images/iso/
COPY scripts/configure-system.sh /source/scripts/configure-system.sh
COPY packages/ /source/packages/
RUN /source/packages/workspaces/build.sh /source/debs
RUN /source/packages/recovery/build.sh /source/recovery-debs
COPY --from=executor / /source/executor-debs/
COPY --from=remote / /source/remote-debs/
ENTRYPOINT ["/bin/bash", "/source/images/iso/build.sh"]
