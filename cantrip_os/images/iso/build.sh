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
cp /source/scripts/configure-system.sh config/hooks/live/0100-cantrip.hook.chroot
chmod 0755 config/hooks/live/0100-cantrip.hook.chroot
lb build
exec bash /source/images/iso/export.sh
