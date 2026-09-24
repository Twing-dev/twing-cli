#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_A="twing-server-lifecycle-test:before"
IMAGE_B="twing-server-lifecycle-test:after"
IMAGE_BAD="twing-server-lifecycle-test:unhealthy"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/twing-server-lifecycle.XXXXXX")"
AUTH_DIR="$TEST_ROOT/auth"
NO_AUTH_DIR="$TEST_ROOT/no-auth"
HTTP_DIR="$TEST_ROOT/http"
AUTH_PORT="${TWING_TEST_AUTH_PORT:-18787}"
NO_AUTH_PORT="${TWING_TEST_NO_AUTH_PORT:-18788}"
HTTP_PORT="${TWING_TEST_HTTP_PORT:-18789}"
AUTH_HTTP_PORT="${TWING_TEST_AUTH_HTTP_PORT:-18080}"
NO_AUTH_HTTP_PORT="${TWING_TEST_NO_AUTH_HTTP_PORT:-18081}"
MONITOR_URL="https://monitor.initial.example"
UPDATED_MONITOR_URL="https://monitor.updated.example"

cleanup() {
  "$REPO_DIR/deploy/twing-server" stop --dir "$AUTH_DIR" >/dev/null 2>&1 || true
  "$REPO_DIR/deploy/twing-server" stop --dir "$NO_AUTH_DIR" >/dev/null 2>&1 || true
  "$REPO_DIR/deploy/twing-server" stop --dir "$HTTP_DIR" >/dev/null 2>&1 || true
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT INT TERM

request_status() {
  curl -ksS -o "$TEST_ROOT/response" -w '%{http_code}' "$@"
}

echo "server lifecycle test: building local image"
docker build -f "$REPO_DIR/packages/server/Dockerfile" -t "$IMAGE_A" "$REPO_DIR"
docker tag "$IMAGE_A" "$IMAGE_B"
docker build -t "$IMAGE_BAD" -f - "$REPO_DIR" <<'EOF'
FROM alpine:3.20
CMD ["false"]
EOF

echo "server lifecycle test: fresh authenticated install"
"$REPO_DIR/deploy/twing-server" install --mode auth --domain localhost --image "$IMAGE_A" --no-pull --dir "$AUTH_DIR" --port "$AUTH_PORT" --http-port "$AUTH_HTTP_PORT" --monitor-url "$MONITOR_URL"
[[ "$(request_status "https://localhost:$AUTH_PORT/v1/projects")" == "401" ]]
grep -q '"authMode":"auth"' <(curl -kfsS "https://localhost:$AUTH_PORT/v1/version")
grep -q '"monitorUrl":"https://monitor.initial.example"' <(curl -kfsS "https://localhost:$AUTH_PORT/v1/version")
grep -qx "TWING_MONITOR_URL=$MONITOR_URL" "$AUTH_DIR/server.env"
grep -qx "TWING_SERVE_CORS_ORIGINS=$MONITOR_URL" "$AUTH_DIR/server.env"
[[ -n "$("$REPO_DIR/deploy/twing-server" bootstrap-token --dir "$AUTH_DIR")" ]]

echo "server lifecycle test: authenticated upgrade preserves state and creates a backup"
docker compose --project-directory "$AUTH_DIR" --env-file "$AUTH_DIR/.env" -f "$AUTH_DIR/compose.yaml" exec -T server sh -c 'printf preserved >/data/upgrade-marker'
"$REPO_DIR/deploy/twing-server" upgrade --image "$IMAGE_B" --no-pull --dir "$AUTH_DIR"
[[ "$(cat "$AUTH_DIR/data/upgrade-marker")" == "preserved" ]]
find "$AUTH_DIR/data/backups" -name 'pre-upgrade-*.db' -type f | grep -q .
grep -qx "TWING_MONITOR_URL=$MONITOR_URL" "$AUTH_DIR/server.env"
grep -qx "TWING_SERVE_CORS_ORIGINS=$MONITOR_URL" "$AUTH_DIR/server.env"

echo "server lifecycle test: remote installer delegates an upgrade to the existing directory"
TWING_SERVER_WRAPPER_URL="file://$REPO_DIR/deploy/twing-server" \
  sh "$REPO_DIR/deploy/install-server.sh" upgrade --image "$IMAGE_B" --no-pull --dir "$AUTH_DIR"
[[ "$(cat "$AUTH_DIR/data/upgrade-marker")" == "preserved" ]]
grep -qx "TWING_MONITOR_URL=$MONITOR_URL" "$AUTH_DIR/server.env"

echo "server lifecycle test: monitor URL update preserves unrelated CORS origins"
printf 'TWING_SERVE_CORS_ORIGINS=https://unrelated.example,%s\n' "$MONITOR_URL" >>"$AUTH_DIR/server.env"
"$REPO_DIR/deploy/twing-server" upgrade --image "$IMAGE_B" --no-pull --dir "$AUTH_DIR" --monitor-url "$UPDATED_MONITOR_URL"
grep -qx "TWING_MONITOR_URL=$UPDATED_MONITOR_URL" "$AUTH_DIR/server.env"
grep -qx "TWING_SERVE_CORS_ORIGINS=https://unrelated.example,$UPDATED_MONITOR_URL" "$AUTH_DIR/server.env"
grep -q '"monitorUrl":"https://monitor.updated.example"' <(curl -kfsS "https://localhost:$AUTH_PORT/v1/version")

echo "server lifecycle test: failed upgrade restores the previous server"
if "$REPO_DIR/deploy/twing-server" upgrade --image "$IMAGE_BAD" --no-pull --dir "$AUTH_DIR"; then
  echo "expected unhealthy upgrade to fail" >&2
  exit 1
fi
[[ "$(cat "$AUTH_DIR/data/upgrade-marker")" == "preserved" ]]
[[ "$(request_status "https://localhost:$AUTH_PORT/v1/projects")" == "401" ]]

echo "server lifecycle test: direct private-network HTTP install"
"$REPO_DIR/deploy/twing-server" install --mode auth --insecure-http --bind 127.0.0.1 --image "$IMAGE_A" --no-pull --dir "$HTTP_DIR" --port "$HTTP_PORT"
[[ "$(request_status "http://127.0.0.1:$HTTP_PORT/v1/projects")" == "401" ]]
grep -q '"authMode":"auth"' <(curl -fsS "http://127.0.0.1:$HTTP_PORT/v1/version")

echo "server lifecycle test: fresh no-auth install"
"$REPO_DIR/deploy/twing-server" install --mode no-auth --domain localhost --image "$IMAGE_A" --no-pull --dir "$NO_AUTH_DIR" --port "$NO_AUTH_PORT" --http-port "$NO_AUTH_HTTP_PORT"
[[ "$(request_status "https://localhost:$NO_AUTH_PORT/v1/auth/whoami")" == "400" ]]
grep -q '"developerId":"local-test@example.com"' <(curl -kfsS -H 'X-Twing-Developer-Id: local-test@example.com' "https://localhost:$NO_AUTH_PORT/v1/auth/whoami")
grep -q '"authMode":"no_auth"' <(curl -kfsS "https://localhost:$NO_AUTH_PORT/v1/version")

echo "server lifecycle test: uninstall preserves data but removes the deployment"
auth_project="$(sed -n 's/^TWING_COMPOSE_PROJECT=//p' "$AUTH_DIR/.env")"
"$REPO_DIR/deploy/twing-server" uninstall --dir "$AUTH_DIR"
[[ "$(cat "$AUTH_DIR/data/upgrade-marker")" == "preserved" ]]
[[ ! -e "$AUTH_DIR/twing-server" && ! -e "$AUTH_DIR/.env" && ! -e "$AUTH_DIR/compose.yaml" ]]
[[ -z "$(docker compose -p "$auth_project" ps -q)" ]]

echo "server lifecycle test: remote installer purges data"
TWING_SERVER_WRAPPER_URL="file://$REPO_DIR/deploy/twing-server" \
  sh "$REPO_DIR/deploy/install-server.sh" uninstall --purge-data --dir "$NO_AUTH_DIR"
[[ ! -e "$NO_AUTH_DIR" ]]

echo "server lifecycle test: PASS"
