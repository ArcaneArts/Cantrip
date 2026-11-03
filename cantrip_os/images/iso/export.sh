#!/bin/bash
set -euo pipefail
cd /build
# Debian's default menu waits indefinitely. Keep recovery entries but boot the
# selected live desktop automatically after three seconds in BIOS and UEFI.
sed -i 's/^timeout .*/timeout 30/' binary/isolinux/isolinux.cfg
printf '\nset timeout=3\n' >> binary/boot/grub/grub.cfg
rm -f /out/cantrip-os-amd64.iso.new
xorriso -indev live-image-amd64.hybrid.iso \
    -outdev /out/cantrip-os-amd64.iso.new -boot_image any replay \
    -map binary/isolinux/isolinux.cfg /isolinux/isolinux.cfg \
    -map binary/boot/grub/grub.cfg /boot/grub/grub.cfg -commit -end
mv /out/cantrip-os-amd64.iso.new /out/cantrip-os-amd64.iso
cp binary/live/filesystem.packages /out/cantrip-os-amd64.packages
cd /out
sha256sum cantrip-os-amd64.iso > cantrip-os-amd64.iso.sha256
