#!/bin/bash
set -euo pipefail
/usr/local/sbin/cantrip-os-identity initialize
install -d -o cantrip -g cantrip -m 0700 /run/user/1000
install -d -m 1777 /tmp/.X11-unix
export XDG_RUNTIME_DIR=/run/user/1000
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0
# Startup runs before any desktop/browser process. A retained home belongs to
# this one instance; processes from the stopped container cannot still own it.
# Remove only Chromium's process coordination files, never its profile data.
rm -f /home/cantrip/.config/chromium/SingletonLock \
    /home/cantrip/.config/chromium/SingletonSocket \
    /home/cantrip/.config/chromium/SingletonCookie
pids=()
cleanup() {
    trap - TERM INT EXIT
    if command -v cantrip-remote >/dev/null; then
        cantrip-remote service stop || true
    fi
    if command -v cantrip-executor >/dev/null; then
        cantrip-executor service stop || true
    fi
    if command -v cantrip-workspaces >/dev/null; then
        cantrip-workspaces service stop || true
    fi
    kill "${pids[@]}" 2>/dev/null || true
    wait || true
}
trap cleanup TERM INT EXIT
# The optional package owns its service and can fail/stop independently of the
# ordinary desktop. Missing package is a supported build choice.
if command -v cantrip-workspaces >/dev/null; then
    cantrip-workspaces service start || echo '[CantripOS] Workspace service failed; see logs.' >&2
fi
if command -v cantrip-executor >/dev/null; then
    cantrip-executor service start || echo '[CantripOS] Executor service failed; see logs.' >&2
fi
if command -v cantrip-remote >/dev/null; then
    cantrip-remote service start || echo '[CantripOS] Remote service failed; see logs.' >&2
fi
runuser -u cantrip -- Xtigervnc :0 -geometry 1440x900 -depth 24 \
    -SecurityTypes None -localhost no -AlwaysShared -ac -rfbport 5900 &
pids+=("$!")
# Try the actual display connection while the server starts. No capability
# guess or permission preflight substitutes for the X server's own result.
for ((attempt=0; attempt<100; attempt++)); do
    if runuser -u cantrip -- xdpyinfo -display :0 >/dev/null 2>&1; then break; fi
    sleep 0.1
done
# LightDM's Xsession does this in the ISO; Docker starts IceWM directly.
runuser -u cantrip -- xrdb -merge /etc/X11/Xresources/50-cantrip-oled
if [ -r /home/cantrip/.Xresources ]; then
    runuser -u cantrip -- xrdb -merge /home/cantrip/.Xresources
fi
runuser -u cantrip -- env HOME=/home/cantrip dbus-run-session -- icewm-session &
pids+=("$!")
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 &
pids+=("$!")
wait -n "${pids[@]}"
