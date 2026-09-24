#!/bin/sh
set -eu

REPOSITORY_URL="${TWING_SERVER_WRAPPER_URL:-https://raw.githubusercontent.com/Twing-dev/twing-cli/main/deploy/twing-server}"
install_dir="${HOME}/.twing/server"
previous=""
action="install"

case "${1:-}" in
  install|upgrade|uninstall)
    action="$1"
    shift
    ;;
  --*|'')
    ;;
  *)
    echo "install-server: expected install, upgrade, or uninstall" >&2
    exit 1
    ;;
esac

for argument in "$@"; do
  if [ "$previous" = "--dir" ]; then
    install_dir="$argument"
    previous=""
  elif [ "$argument" = "--dir" ]; then
    previous="--dir"
  fi
done

case "$install_dir" in
  /*) ;;
  *) install_dir="$PWD/$install_dir" ;;
esac

command -v curl >/dev/null 2>&1 || { echo "install-server: curl is required" >&2; exit 1; }

if [ "$action" = "uninstall" ]; then
  installer="$(mktemp "${TMPDIR:-/tmp}/twing-server.XXXXXX")"
  trap 'rm -f "$installer"' EXIT HUP INT TERM
else
  mkdir -p "$install_dir"
  installer="$install_dir/twing-server"
fi

curl -fsSL "$REPOSITORY_URL" -o "$installer"
chmod 700 "$installer"
if [ "$action" = "uninstall" ]; then
  "$installer" "$action" "$@"
  exit $?
fi
exec "$installer" "$action" "$@"
