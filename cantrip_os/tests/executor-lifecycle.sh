#!/bin/sh
# Run as root in a disposable Docker or installed OS. Package: /tmp/executor.deb.
# The real exec-a / exec-b workspace accounts must already exist.
set -eu
status() {
    cantrip-executor status | python3 -c 'import json,sys; s=json.load(sys.stdin); assert s["service"]==sys.argv[1] and s["enabled"]==(sys.argv[2]=="true"),s; print(s)' "$1" "$2"
    if [ -d /run/systemd/system ] && [ "$2" = true ]; then
        systemctl is-enabled --quiet cantrip-os-executor.service
    fi
}
desktop() {
    runuser -u cantrip -- xdpyinfo -display :0 >/dev/null
    if [ -d /run/systemd/system ]; then
        systemctl is-active --quiet lightdm
    else
        curl -fsS http://127.0.0.1:6080/ >/dev/null
    fi
    test "$(pgrep -u ctw-exec-b -x icewm)" = "$wm"
}
status running true
identity=$(cantrip-executor status | python3 -c 'import json,sys; print(json.load(sys.stdin)["instance_id"])')
cantrip-workspaces open exec-b
wm=$(pgrep -u ctw-exec-b -x icewm)
runuser -u ctw-exec-a -- sh -c 'printf "retained-executor-data\n" > "$HOME/Documents/executor-retained.txt"'
cantrip-executor open exec-a
cantrip-executor open exec-b
cantrip-executor disable
status stopped false
desktop
apt-get remove -y cantrip-os-executor
desktop
test "$(cat /var/lib/cantrip-os-workspaces/homes/exec-a/Documents/executor-retained.txt)" = retained-executor-data
apt-get install -y /tmp/executor.deb
status stopped false
cantrip-executor enable
status running true
test "$(cantrip-executor status | python3 -c 'import json,sys; print(json.load(sys.stdin)["instance_id"])')" = "$identity"
cantrip-executor open exec-a
apt-get install --reinstall -y /tmp/executor.deb
status running true
desktop
cantrip-executor disable
apt-get purge -y cantrip-os-executor
desktop
test "$(cat /var/lib/cantrip-os-workspaces/homes/exec-a/Documents/executor-retained.txt)" = retained-executor-data
apt-get install -y /tmp/executor.deb
status stopped false
cp /var/lib/cantrip-os-executor/instance.json /tmp/executor-identity.backup
python3 - <<'PY'
import json
from pathlib import Path
p=Path('/var/lib/cantrip-os-executor/instance.json')
s=json.loads(p.read_text());s['version']=99;p.write_text(json.dumps(s)+'\n')
PY
if cantrip-executor enable; then
    echo 'Unknown identity version unexpectedly started' >&2
    exit 1
fi
python3 - <<'PY'
import json
from pathlib import Path
assert json.loads(Path('/var/lib/cantrip-os-executor/instance.json').read_text())['version']==99
PY
cp /tmp/executor-identity.backup /var/lib/cantrip-os-executor/instance.json
cantrip-executor enable
status running true
desktop
test "$(cantrip-executor status | python3 -c 'import json,sys; print(json.load(sys.stdin)["instance_id"])')" = "$identity"
echo 'Executor lifecycle, retained identity/data, unsupported state and independent desktop: PASS'
