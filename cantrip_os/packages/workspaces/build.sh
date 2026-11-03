#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output_dir=${1:-/out}
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-1793664000}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
cp -a "$source_dir/root/." "$stage/"
mkdir -p "$stage/DEBIAN" "$output_dir"
cp "$source_dir"/debian/* "$stage/DEBIAN/"
find "$stage" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
dpkg-deb --root-owner-group --uniform-compression -Zxz -z6 --build "$stage" "$output_dir/cantrip-os-workspaces_0.3.0_all.deb"
