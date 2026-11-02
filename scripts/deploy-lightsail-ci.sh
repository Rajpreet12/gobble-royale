#!/usr/bin/env bash
# Ships the game to the Lightsail server from CI, proves it's live, and rolls back by itself if not.
#   VERSION=<git sha> bash scripts/deploy-lightsail-ci.sh
# Needs AWS credentials (GitHub OIDC role) allowed to manage SSH access on this one instance.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${VERSION:?set VERSION to the git commit being deployed}"
REGION="${AWS_REGION:-us-east-1}"
INSTANCE="${INSTANCE:-gobble-royale}"
HOST="${HOST:-gobble.98-88-244-8.sslip.io}"
URL="https://$HOST"
WORK="$(mktemp -d)"

# The firewall's normal state. Whatever happens below, the trap puts it back.
BASE_PORTS='[{"fromPort":80,"toPort":80,"protocol":"tcp","cidrs":["0.0.0.0/0"],"ipv6Cidrs":["::/0"]},{"fromPort":443,"toPort":443,"protocol":"tcp","cidrs":["0.0.0.0/0"],"ipv6Cidrs":["::/0"]},{"fromPort":22,"toPort":22,"protocol":"tcp","cidrListAliases":["lightsail-connect"]}]'
# shellcheck disable=SC2329 # called by the EXIT trap below
restore_firewall() {
  aws lightsail put-instance-public-ports --region "$REGION" --instance-name "$INSTANCE" --port-infos "$BASE_PORTS" >/dev/null && echo "Firewall back to normal (SSH closed to the internet)"
  rm -rf "$WORK"
}
trap restore_firewall EXIT

echo "::group::Bundle $VERSION"
echo "$VERSION" > server/VERSION
(cd server && zip -qr "$WORK/bundle.zip" package.json package-lock.json VERSION src public scripts)
sed "s/__HOST__/$HOST/" infra/Caddyfile > "$WORK/Caddyfile"
echo "::endgroup::"

echo "::group::Open SSH to this runner only"
RUNNER_IP="$(curl -fsS https://checkip.amazonaws.com)"
aws lightsail open-instance-public-ports --region "$REGION" --instance-name "$INSTANCE" \
  --port-info "fromPort=22,toPort=22,protocol=tcp,cidrs=$RUNNER_IP/32" >/dev/null
# A short-lived SSH certificate from Lightsail, and the server's real host key, so the connection
# can't be intercepted (no "accept any host key").
aws lightsail get-instance-access-details --region "$REGION" --instance-name "$INSTANCE" --protocol ssh --output json > "$WORK/access.json"
jq -r .accessDetails.privateKey "$WORK/access.json" > "$WORK/key" && chmod 600 "$WORK/key"
jq -r .accessDetails.certKey "$WORK/access.json" > "$WORK/key-cert.pub"
SERVER_IP="$(jq -r .accessDetails.ipAddress "$WORK/access.json")"
jq -r --arg ip "$SERVER_IP" '.accessDetails.hostKeys[] | "\($ip) \(.algorithm) \(.publicKey)"' "$WORK/access.json" > "$WORK/known_hosts"
rm "$WORK/access.json"
SSH_OPTS=(-i "$WORK/key" -o "CertificateFile=$WORK/key-cert.pub" -o "UserKnownHostsFile=$WORK/known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=15)
# shellcheck disable=SC2029 # every command passed in is single-quoted: it runs on the server as written
remote() { ssh "${SSH_OPTS[@]}" "ubuntu@$SERVER_IP" "$@"; }
echo "::endgroup::"

echo "::group::Install"
scp "${SSH_OPTS[@]}" "$WORK/bundle.zip" "$WORK/Caddyfile" "ubuntu@$SERVER_IP:/tmp/"
remote 'sudo gobble-update file:///tmp/bundle.zip'
# Caddy: only if the config changed, only if it validates, and with a graceful reload (no dropped players)
remote 'if ! sudo cmp -s /tmp/Caddyfile /etc/caddy/Caddyfile; then
          caddy validate --config /tmp/Caddyfile --adapter caddyfile &&
          sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak &&
          sudo cp /tmp/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy && echo "Caddy config updated"
        else echo "Caddy config unchanged"; fi
        rm -f /tmp/bundle.zip /tmp/Caddyfile'
echo "::endgroup::"

echo "::group::Smoke test"
if node scripts/smoke.mjs "$URL" "$VERSION"; then
  echo "::endgroup::"
  echo "Deployed $VERSION"
  exit 0
fi
echo "::endgroup::"

# The new version isn't healthy: put the previous one back, check it's serving, and fail loudly.
echo "::error::Smoke test failed for $VERSION. Rolling back."
remote 'test -d /opt/gobble.prev && sudo rm -rf /opt/gobble.bad && sudo mv /opt/gobble /opt/gobble.bad && sudo mv /opt/gobble.prev /opt/gobble && sudo systemctl restart gobble'
for _ in $(seq 1 15); do
  if curl -fsS "$URL/health"; then echo; echo "::warning::Rolled back. The failed version is in /opt/gobble.bad for debugging."; exit 1; fi
  sleep 2
done
echo "::error::Rollback did not bring the game back. Follow docs/RUNBOOK.md ([PAGE] section) now."
exit 1
