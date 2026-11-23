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

# Both editions ship only our editable theme; retain personal home overrides.
find /usr/share/icewm/themes -mindepth 1 -maxdepth 1 ! -name cantrip-oled -exec rm -rf {} +

glib-compile-schemas --strict /usr/share/glib-2.0/schemas

chmod 0755 /usr/local/sbin/cantrip-os-identity
install -d /etc/systemd/system/multi-user.target.wants
ln -sf ../cantrip-os-identity.service /etc/systemd/system/multi-user.target.wants/cantrip-os-identity.service
# Debian's D-Bus install generates an ID during the build. Templates must not
# distribute that ID or an integration package's enrollment/key state.
/usr/local/sbin/cantrip-os-identity prepare-clone
