#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output_dir=${1:-/out}
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-1793664000}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
cp -a "$source_dir/root/." "$stage/"
# Local syntax checks and earlier guest runs may leave platform/version-specific
# bytecode in the source tree. Only Python source belongs in this package.
find "$stage" -type d -name __pycache__ -prune -exec rm -rf {} +
find "$stage" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete
mkdir -p "$stage/DEBIAN" "$output_dir"
cp "$source_dir"/debian/* "$stage/DEBIAN/"
find "$stage" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
dpkg-deb --root-owner-group --uniform-compression -Zxz -z6 --build "$stage" "$output_dir/cantrip-os-recovery_0.3.0_all.deb"
