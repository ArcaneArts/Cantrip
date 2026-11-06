#!/bin/bash
set -euo pipefail
cd /build
# Cache downloaded packages between builds. The build tree itself is recreated
# so removed source files and package changes cannot silently remain installed.
lb clean
rm -rf config auto local .build chroot binary
lb config --mode debian --distribution trixie --architectures amd64 \
    --binary-images iso-hybrid --bootloaders 'syslinux,grub-efi' \
    --archive-areas 'main non-free-firmware' --apt-recommends false \
    --debian-installer false --memtest none \
    --iso-application CantripOS --iso-volume CANTRIP_OS \
    --iso-publisher Cantrip --iso-preparer Cantrip \
    --bootappend-live 'boot=live components username=cantrip hostname=cantrip-os locales=en_US.UTF-8 keyboard-layouts=us console=tty0 console=ttyS0,115200n8' \
    --chroot-squashfs-compression-type zstd --chroot-squashfs-compression-level 3
cat /source/manifests/desktop.packages /source/manifests/iso.packages \
    > config/package-lists/cantrip.list.chroot
mkdir -p config/includes.chroot config/hooks/live
cp -a /source/overlays/. config/includes.chroot/
cp -a /source/images/iso/overlays/. config/includes.chroot/
case "${CANTRIP_OS_WORKSPACES:-1}" in
    1) mkdir -p config/packages.chroot
       cp /source/debs/*.deb config/packages.chroot/ ;;
    0) ;;
    *) echo 'CANTRIP_OS_WORKSPACES must be 0 or 1' >&2; exit 1 ;;
esac
case "${CANTRIP_OS_EXECUTOR:-0}" in
    1) mkdir -p config/packages.chroot
       cp /source/executor-debs/*.deb config/packages.chroot/ ;;
    0) ;;
    *) echo 'CANTRIP_OS_EXECUTOR must be 0 or 1' >&2; exit 1 ;;
esac
case "${CANTRIP_OS_REMOTE:-0}" in
    1) mkdir -p config/packages.chroot
       cp /source/remote-debs/*.deb config/packages.chroot/ ;;
    0) ;;
    *) echo 'CANTRIP_OS_REMOTE must be 0 or 1' >&2; exit 1 ;;
esac
case "${CANTRIP_OS_RECOVERY:-0}" in
    1) mkdir -p config/packages.chroot
       cp /source/recovery-debs/*.deb config/packages.chroot/ ;;
    0) ;;
    *) echo 'CANTRIP_OS_RECOVERY must be 0 or 1' >&2; exit 1 ;;
esac
cp /source/scripts/configure-system.sh config/hooks/live/0100-cantrip.hook.chroot
chmod 0755 config/hooks/live/0100-cantrip.hook.chroot
lb build
exec bash /source/images/iso/export.sh
