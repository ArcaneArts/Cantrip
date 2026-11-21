#!/bin/sh
set -eu
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
output_dir=${1:-/out}
viewer_dir=${2:?Provide the extracted noVNC viewer directory}
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1793664000}"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
cp -a "$source_dir/root/." "$stage/"
install -d "$stage/usr/share/cantrip-os-workspaces/novnc"
cp -a "$viewer_dir/www/core" "$viewer_dir/www/vendor" "$stage/usr/share/cantrip-os-workspaces/novnc/"
install -m 0644 "$viewer_dir/novnc-version" "$stage/usr/share/cantrip-os-workspaces/novnc/version"
install -d "$stage/usr/share/doc/cantrip-os-workspaces"
install -m 0644 "$viewer_dir/doc/copyright" "$stage/usr/share/doc/cantrip-os-workspaces/copyright"
find "$stage" -type d -name __pycache__ -prune -exec rm -rf {} +
find "$stage" -type f -name '*.pyc' -delete
mkdir -p "$stage/DEBIAN" "$output_dir"
cp "$source_dir"/debian/* "$stage/DEBIAN/"
find "$stage" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
dpkg-deb --root-owner-group --uniform-compression -Zxz -z6 --build "$stage" "$output_dir/cantrip-os-workspaces_0.5.0_all.deb"
