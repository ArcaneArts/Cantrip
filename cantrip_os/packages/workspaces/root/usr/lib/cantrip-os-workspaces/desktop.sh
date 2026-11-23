#!/bin/sh
set -eu
cd "$HOME"
rm -f .config/chromium/SingletonLock .config/chromium/SingletonSocket .config/chromium/SingletonCookie
# Theme defaults are optional on older/base installations. Let xrdb report its
# real error, then continue the desktop independently of the color override.
xrdb -merge /etc/X11/Xresources/50-cantrip-oled || true
if [ -r "$HOME/.Xresources" ]; then xrdb -merge "$HOME/.Xresources" || true; fi
exec icewm-session
