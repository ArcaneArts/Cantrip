#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runtime=${1:?native runtime directory}
output=${2:-/out}
architecture=$(dpkg --print-architecture)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
cp -a "$source_dir/root/." "$stage/"
find "$stage" -type d -name __pycache__ -prune -exec rm -r -- {} +
mkdir -p "$stage/DEBIAN" "$stage/usr/share/doc/cantrip-os-remote" "$output"
cp "$source_dir"/debian/* "$stage/DEBIAN/"
sed -i "s/@ARCH@/$architecture/" "$stage/DEBIAN/control"
install -m 0755 "$runtime/cantrip-cua" "$stage/usr/lib/cantrip-os-remote/cantrip-cua"
cp -a "$runtime/openssh" "$stage/usr/lib/cantrip-os-remote/"
cp -a "$runtime/licenses" "$runtime/build-manifest.sha256" "$stage/usr/share/doc/cantrip-os-remote/"
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-1793742880}
find "$stage" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
dpkg-deb --root-owner-group --uniform-compression -Zxz -z6 --build "$stage" "$output/cantrip-os-remote_0.11.0_$architecture.deb"
