#!/bin/sh
set -eu
output_dir=$1
download=$(mktemp -d)
trap 'rm -rf "$download"' EXIT HUP INT TERM
chown _apt "$download"
apt-get update
(cd "$download" && apt-get download novnc)
set -- "$download"/novnc_*.deb
dpkg-deb --extract "$1" "$download/extracted"

# Python websockify serves these files directly to the browser.
assets="$download/extracted/usr/share/novnc"
install -d "$output_dir/www" "$output_dir/doc"
for asset in app core include vendor defaults.json mandatory.json vnc.html vnc_auto.html vnc_lite.html; do
    cp -a "$assets/$asset" "$output_dir/www/"
done
install -m 0644 "$download/extracted/usr/share/doc/novnc/copyright" "$output_dir/doc/copyright"
dpkg-deb --field "$1" Version > "$output_dir/novnc-version"
