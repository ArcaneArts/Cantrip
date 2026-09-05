#!/usr/bin/env bash
# Shared worker/client Developer ID import. Never changes the default keychain.
set -euo pipefail

cleanup_keychain() {
  if [ -n "${CANTRIP_SIGNING_KEYCHAIN:-}" ]; then
    security delete-keychain "$CANTRIP_SIGNING_KEYCHAIN"
  fi
}

if [ "${1:-import}" = cleanup ]; then
  cleanup_keychain
  exit
fi
if [ "${1:-import}" != import ] || [ "$#" -gt 1 ]; then
  echo "Usage: bash scripts/import-macos-developer-id.sh [import|cleanup]" >&2
  exit 1
fi

: "${APPLE_CERTIFICATE:?Configure the APPLE_CERTIFICATE Actions secret.}"
: "${APPLE_CERTIFICATE_PASSWORD:?Configure the APPLE_CERTIFICATE_PASSWORD Actions secret.}"
: "${KEYCHAIN_PASSWORD:?Configure the KEYCHAIN_PASSWORD Actions secret.}"
certificate="$RUNNER_TEMP/cantrip-signing.p12"
keychain="$RUNNER_TEMP/cantrip-signing.keychain-db"
developer_id_g1="$RUNNER_TEMP/DeveloperIDCA.cer"
developer_id_g2="$RUNNER_TEMP/DeveloperIDG2CA.cer"
leaf_certificate="$RUNNER_TEMP/cantrip-signing-leaf.pem"
keychain_created=false
import_complete=false
finish_import() {
  local result=$?
  rm -f "$certificate" "$developer_id_g1" "$developer_id_g2" "$leaf_certificate"
  if [ "$keychain_created" = true ] && [ "$import_complete" != true ]; then
    CANTRIP_SIGNING_KEYCHAIN="$keychain" cleanup_keychain || true
  fi
  exit "$result"
}
trap finish_import EXIT
umask 077
printf '%s' "$APPLE_CERTIFICATE" | openssl base64 -d -A -out "$certificate"

existing_keychains_output="$(security list-keychains -d user)"
existing_keychains=()
while IFS= read -r existing_keychain; do
  existing_keychain="${existing_keychain//\"/}"
  existing_keychain="${existing_keychain#"${existing_keychain%%[![:space:]]*}"}"
  if [ -n "$existing_keychain" ]; then
    existing_keychains+=("$existing_keychain")
  fi
done <<< "$existing_keychains_output"

security create-keychain -p "$KEYCHAIN_PASSWORD" "$keychain"
keychain_created=true
security list-keychains -d user -s "$keychain" "${existing_keychains[@]}"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$keychain"
security set-keychain-settings -t 3600 -u "$keychain"
security import "$certificate" \
  -k "$keychain" \
  -P "$APPLE_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign

curl --fail --silent --show-error --location \
  https://www.apple.com/certificateauthority/DeveloperIDCA.cer \
  --output "$developer_id_g1"
curl --fail --silent --show-error --location \
  https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer \
  --output "$developer_id_g2"
printf '%s  %s\n' \
  '7afc9d01a62f03a2de9637936d4afe68090d2de18d03f29c88cfb0b1ba63587f' \
  "$developer_id_g1" \
  'f16cd3c54c7f83cea4bf1a3e6a0819c8aaa8e4a1528fd144715f350643d2df3a' \
  "$developer_id_g2" \
  | shasum -a 256 --check
security import "$developer_id_g1" -k "$keychain"
security import "$developer_id_g2" -k "$keychain"

security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$KEYCHAIN_PASSWORD" \
  "$keychain"

security find-certificate \
  -a \
  -c 'Developer ID Application' \
  -p \
  "$keychain" \
  > "$leaf_certificate"
if [ ! -s "$leaf_certificate" ]; then
  echo "APPLE_CERTIFICATE does not contain a Developer ID Application certificate." >&2
  exit 1
fi
openssl x509 -in "$leaf_certificate" -noout -subject -issuer -dates
leaf_fingerprint="$(
  openssl x509 -in "$leaf_certificate" -noout -fingerprint -sha1 \
    | cut -d= -f2 \
    | tr -d ':'
)"
identities="$(security find-identity -v -p codesigning || true)"
identity="$(
  printf '%s\n' "$identities" \
    | awk -v fingerprint="$leaf_fingerprint" '
        $2 == fingerprint && /"Developer ID Application:/ {
          line = $0
          sub(/^[^"]*"/, "", line)
          sub(/".*$/, "", line)
          print line
          exit
        }
      '
)"
if [ -z "$identity" ]; then
  printf '%s\n' "$identities" >&2
  echo "The imported Developer ID Application certificate and private key did not form a valid code-signing identity." >&2
  exit 1
fi
echo "APPLE_SIGNING_IDENTITY=$identity" >> "$GITHUB_ENV"
echo "CANTRIP_SIGNING_KEYCHAIN=$keychain" >> "$GITHUB_ENV"
import_complete=true
