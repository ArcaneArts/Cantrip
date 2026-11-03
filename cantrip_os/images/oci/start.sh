#!/bin/bash
set -euo pipefail
install -d -o cantrip -g cantrip -m 0700 /run/user/1000
install -d -m 1777 /tmp/.X11-unix
export XDG_RUNTIME_DIR=/run/user/1000
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0
pids=()
cleanup() {
    trap - TERM INT EXIT
    kill "${pids[@]}" 2>/dev/null || true
    wait || true
}
trap cleanup TERM INT EXIT
runuser -u cantrip -- Xtigervnc :0 -geometry 1440x900 -depth 24 \
    -SecurityTypes None -localhost yes -AlwaysShared -ac -rfbport 5900 &
pids+=("$!")
# Try the actual display connection while the server starts. No capability
# guess or permission preflight substitutes for the X server's own result.
for ((attempt=0; attempt<100; attempt++)); do
    if runuser -u cantrip -- xdpyinfo -display :0 >/dev/null 2>&1; then break; fi
    sleep 0.1
done
runuser -u cantrip -- env HOME=/home/cantrip dbus-run-session -- icewm-session &
pids+=("$!")
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 &
pids+=("$!")
wait -n "${pids[@]}"
