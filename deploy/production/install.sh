#!/usr/bin/env bash
set -euo pipefail

release_id=${1:-}
artifact_path=${2:-}
asset_directory=${3:-}

if [[ ! $release_id =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid release identifier." >&2
  exit 2
fi
if [[ ! -f $artifact_path || ! -d $asset_directory ]]; then
  echo "The release artifact or deployment assets are missing." >&2
  exit 2
fi
if [[ ! -s /etc/cantrip/production.env ]]; then
  echo "The production service environment is missing." >&2
  exit 2
fi

release_directory="/opt/cantrip/releases/$release_id"
incoming_directory="/opt/cantrip/releases/.${release_id}.incoming"
previous_release=""
if [[ -L /opt/cantrip/current ]]; then
  previous_release=$(readlink -f /opt/cantrip/current)
fi

export DEBIAN_FRONTEND=noninteractive
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update
  apt-get install --yes --no-install-recommends caddy
fi

if ! getent group cantrip >/dev/null; then
  groupadd --system cantrip
fi
if ! id cantrip >/dev/null 2>&1; then
  useradd \
    --system \
    --gid cantrip \
    --home-dir /var/lib/cantrip \
    --shell /usr/sbin/nologin \
    cantrip
fi

install -d -o root -g root -m 0755 /opt/cantrip /opt/cantrip/releases
install -d -o cantrip -g cantrip -m 0700 /var/lib/cantrip
install -d -o root -g root -m 0700 /etc/cantrip
install -d -o root -g root -m 0755 /etc/caddy

if [[ ! -x $release_directory/start.sh || ! -x $release_directory/migrate.sh || ! -x $release_directory/runtime/node ]]; then
  if [[ $previous_release == "$release_directory" ]]; then
    echo "The active release directory is incomplete; refusing to replace it in place." >&2
    exit 1
  fi
  rm -rf -- "$incoming_directory"
  install -d -o root -g root -m 0755 "$incoming_directory"
  tar -xzf "$artifact_path" -C "$incoming_directory"
  chmod 0755 "$incoming_directory"
  test -x "$incoming_directory/start.sh"
  test -x "$incoming_directory/migrate.sh"
  test -x "$incoming_directory/runtime/node"
  chown -R root:root "$incoming_directory"
  chmod -R go-w "$incoming_directory"
  if [[ -e $release_directory ]]; then
    rm -rf -- "$release_directory"
  fi
  mv "$incoming_directory" "$release_directory"
fi

install -o root -g root -m 0644 \
  "$asset_directory/cantrip-server.service" \
  /etc/systemd/system/cantrip-server.service
install -o root -g root -m 0644 \
  "$asset_directory/cantrip-migrate@.service" \
  /etc/systemd/system/cantrip-migrate@.service
install -o root -g root -m 0644 \
  "$asset_directory/Caddyfile" \
  /etc/caddy/Caddyfile

caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload

if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
fi

migration_unit="cantrip-migrate@$release_id.service"
systemctl reset-failed "$migration_unit" >/dev/null 2>&1 || true
if ! systemctl start "$migration_unit"; then
  journalctl --no-pager --lines=100 --unit "$migration_unit" >&2 || true
  exit 1
fi

ln -sfn "$release_directory" /opt/cantrip/current.next
mv -Tf /opt/cantrip/current.next /opt/cantrip/current

systemctl enable cantrip-server.service caddy.service >/dev/null
systemctl restart caddy.service
systemctl restart cantrip-server.service

ready=false
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:4310/readyz >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done

if [[ $ready != true ]]; then
  journalctl --no-pager --lines=100 --unit cantrip-server.service >&2 || true
  if [[ -n $previous_release && -d $previous_release ]]; then
    ln -sfn "$previous_release" /opt/cantrip/current.next
    mv -Tf /opt/cantrip/current.next /opt/cantrip/current
    systemctl restart cantrip-server.service || true
    echo "The server did not become ready; restored the previous release." >&2
  else
    echo "The server did not become ready and no previous release exists." >&2
  fi
  exit 1
fi

echo "Cantrip release ${release_id:0:12} is ready."
