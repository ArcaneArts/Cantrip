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

if [[ ! -d $release_directory ]]; then
  rm -rf -- "$incoming_directory"
  install -d -o root -g root -m 0755 "$incoming_directory"
  tar -xzf "$artifact_path" -C "$incoming_directory"
  chmod 0755 "$incoming_directory"
  chown -R root:root "$incoming_directory"
  chmod -R go-w "$incoming_directory"
  if [[ -e $release_directory ]]; then
    rm -rf -- "$release_directory"
  fi
  mv "$incoming_directory" "$release_directory"
fi

# Keep the previous configuration until the candidate has actually migrated and
# served requests. The uploader stages new secrets beside the archive rather
# than overwriting the live environment before this transaction begins.
rollback_directory=$(mktemp -d /etc/cantrip/.rollback.XXXXXX)
transition_started=false
previous_server_active=false
previous_caddy_active=false
systemctl is-active --quiet cantrip-server.service && previous_server_active=true
systemctl is-active --quiet caddy.service && previous_caddy_active=true
configuration_files=(
  /etc/cantrip/production.env
  /etc/systemd/system/cantrip-server.service
  /etc/systemd/system/cantrip-migrate@.service
  /etc/caddy/Caddyfile
)
for index in "${!configuration_files[@]}"; do
  file=${configuration_files[$index]}
  if [[ -f $file ]]; then cp -p "$file" "$rollback_directory/$index"; fi
done


restart_server() {
  # An intentional activation has its own start budget. Failed candidate
  # retries must not consume the budget for restoring the previous release.
  systemctl reset-failed cantrip-server.service >/dev/null 2>&1 || true
  systemctl restart cantrip-server.service
}

finish() {
  result=$?
  trap - EXIT INT TERM
  set +e
  if [[ $result != 0 && $transition_started == true ]]; then
    # Stop a partially started candidate before restoring configuration/data
    # ownership. Never restore a database snapshot: accepted writes stay intact.
    systemctl stop cantrip-server.service || true
    for index in "${!configuration_files[@]}"; do
      file=${configuration_files[$index]}
      if [[ -f $rollback_directory/$index ]]; then
        cp -p "$rollback_directory/$index" "$file"
      else
        rm -f -- "$file"
      fi
    done
    if [[ -n $previous_release ]]; then
      ln -sfn "$previous_release" /opt/cantrip/current.next
      mv -Tf /opt/cantrip/current.next /opt/cantrip/current
    else
      rm -f -- /opt/cantrip/current
    fi
    systemctl daemon-reload
    if [[ $previous_caddy_active == true ]]; then
      systemctl restart caddy.service || true
    else
      systemctl stop caddy.service || true
    fi
    if [[ $previous_server_active == true ]]; then
      restart_server
      recovered=false
      for _ in $(seq 1 30); do
        if curl --max-time 2 --fail --silent http://127.0.0.1:4310/readyz >/dev/null; then
          recovered=true
          break
        fi
        sleep 1
      done
      if [[ $recovered == true ]]; then
        echo "Deployment failed; the previous release is ready with its restored configuration." >&2
      else
        echo "Deployment failed; restored the previous release and configuration, but readiness still fails." >&2
        journalctl --no-pager --lines=100 --unit cantrip-server.service >&2
      fi
    else
      echo "Deployment failed; restored configuration and left the server stopped." >&2
    fi
  fi
  rm -rf -- "$rollback_directory"
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Validate the real proxy configuration before stopping the current service.
caddy validate --config "$asset_directory/Caddyfile"
transition_started=true
# PGlite and private PostgreSQL have a single profile owner. Stopping before the
# explicit migration also gives external PostgreSQL a consistent offline window.
systemctl stop cantrip-server.service 2>/dev/null || {
  # A first installation has no unit yet. Attempt loading the supplied unit
  # and stopping it, rather than inferring support from an artifact marker.
  install -o root -g root -m 0644 "$asset_directory/cantrip-server.service" /etc/systemd/system/cantrip-server.service
  systemctl daemon-reload
  systemctl stop cantrip-server.service
}
if [[ -f $asset_directory/production.env ]]; then
  install -o root -g root -m 0600 "$asset_directory/production.env" /etc/cantrip/production.env
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

systemctl restart caddy.service
restart_server

ready=false
for _ in $(seq 1 30); do
  if curl --max-time 2 --fail --silent --show-error http://127.0.0.1:4310/readyz >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done

if [[ $ready != true ]]; then
  journalctl --no-pager --lines=100 --unit cantrip-server.service >&2 || true
  exit 1
fi

# Retain the exact environment for an explicit code rollback against the latest
# database. This directory is root-only; it is never copied into public artifacts.
install -d -o root -g root -m 0700 "/etc/cantrip/releases/$release_id"
install -o root -g root -m 0600 /etc/cantrip/production.env "/etc/cantrip/releases/$release_id/production.env"
systemctl enable cantrip-server.service caddy.service >/dev/null
transition_started=false
echo "Cantrip release ${release_id:0:12} is ready."
