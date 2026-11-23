#!/bin/sh
# Run as root in a disposable, running CantripOS container. Package at /tmp/workspaces.deb.
set -eu
assert_status() {
    cantrip-workspaces status | python3 -c 'import json,sys; s=json.load(sys.stdin); assert s["service"] == sys.argv[1] and s["enabled"] == (sys.argv[2] == "true"), s; print(s)' "$1" "$2"
}
assert_desktop() {
    runuser -u cantrip -- xdpyinfo -display :0 >/dev/null
    curl -fsS http://127.0.0.1:6080/ >/dev/null
}
assert_status running true
printf 'preserve-me\n' > /var/lib/cantrip-os-workspaces/package-test.txt
cantrip-workspaces disable
assert_status stopped false
assert_desktop
cantrip-workspaces service start
assert_status stopped false
cantrip-workspaces enable
assert_status running true
cantrip-workspaces service restart
assert_status running true
# Normal Debian reinstall/upgrade path, while the service is running.
apt-get install --reinstall -y /tmp/workspaces.deb
assert_status running true
cantrip-workspaces disable
apt-get install --reinstall -y /tmp/workspaces.deb
assert_status stopped false
assert_desktop
apt-get remove -y cantrip-os-workspaces
assert_desktop
test "$(cat /var/lib/cantrip-os-workspaces/package-test.txt)" = preserve-me
apt-get install -y /tmp/workspaces.deb
assert_status stopped false
cantrip-workspaces enable
assert_status running true
apt-get purge -y cantrip-os-workspaces
assert_desktop
test "$(cat /var/lib/cantrip-os-workspaces/package-test.txt)" = preserve-me
apt-get install -y /tmp/workspaces.deb
cantrip-workspaces service start
assert_status running true
# Unknown versions must fail without silently replacing state.
cp /var/lib/cantrip-os-workspaces/settings.json /tmp/settings.saved
printf '{"version":999,"enabled":true}\n' > /var/lib/cantrip-os-workspaces/settings.json
if cantrip-workspaces status; then echo 'Unsupported state accepted' >&2; exit 1; fi
cmp /var/lib/cantrip-os-workspaces/settings.json /dev/stdin <<'EOF'
{"version":999,"enabled":true}
EOF
cantrip-workspaces service stop
mv /tmp/settings.saved /var/lib/cantrip-os-workspaces/settings.json
cantrip-workspaces service start
assert_status running true
assert_desktop
echo 'Package lifecycle and independent personal desktop: PASS'
