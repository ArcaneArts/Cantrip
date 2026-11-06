#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runtime_dir=$1
output_dir=${2:-/out}
arch=$(dpkg --print-architecture)
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-1793664000}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
cp -a "$source_dir/root/." "$stage/"
# Syntax checks on a developer's machine must not ship its Python bytecode.
find "$stage" -type d -name __pycache__ -prune -exec rm -rf {} +
find "$stage" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete
mkdir -p "$stage/DEBIAN" "$stage/usr/lib/cantrip-os-executor/runtime" "$output_dir"
cp -a "$runtime_dir/." "$stage/usr/lib/cantrip-os-executor/runtime/"
# Local BuildKit exports can give their destination root private permissions.
# Package runtime directories must be traversable by the workspace accounts.
find "$stage/usr/lib/cantrip-os-executor/runtime" -type d -exec chmod 0755 {} +
chmod 0755 "$stage/usr/lib/cantrip-os-executor/runtime/codex-exec-server" \
    "$stage/usr/lib/cantrip-os-executor/runtime/codex-resources/bwrap"
cp "$source_dir"/debian/* "$stage/DEBIAN/"
sed -i "s/@ARCH@/$arch/" "$stage/DEBIAN/control"
find "$stage" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
dpkg-deb --root-owner-group --uniform-compression -Zxz -z6 --build "$stage" "$output_dir/cantrip-os-executor_0.10.0_${arch}.deb"
