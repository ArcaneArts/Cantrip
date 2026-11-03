#!/bin/sh
set -eu
cd "$HOME"
rm -f .config/chromium/SingletonLock .config/chromium/SingletonSocket .config/chromium/SingletonCookie
xrdb -merge /etc/X11/Xresources/50-cantrip-oled
if [ -r "$HOME/.Xresources" ]; then xrdb -merge "$HOME/.Xresources"; fi
exec icewm-session
