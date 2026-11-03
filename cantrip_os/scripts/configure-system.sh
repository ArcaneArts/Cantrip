#!/bin/sh
set -eu
if ! id cantrip >/dev/null 2>&1; then
    useradd --create-home --uid 1000 --shell /bin/bash cantrip
fi
passwd -d cantrip
printf '%s\n' 'cantrip ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/cantrip
chmod 0440 /etc/sudoers.d/cantrip
printf '%s\n' 'en_US.UTF-8 UTF-8' > /etc/locale.gen
locale-gen
chmod 0755 /usr/local/bin/cantrip-*
install -d -o cantrip -g cantrip /home/cantrip/Documents /home/cantrip/Downloads
