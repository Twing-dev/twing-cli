#!/usr/bin/env bash
set -euo pipefail

# Creates an isolated, loginable user for running `twing serve`, with SSH
# access mirrored from an existing account -- so anyone who could already
# SSH in keeps access, without granting the new account any path into the
# source account's files or sudo. Safe to re-run: already-done steps are
# skipped rather than failing.
#
# Usage: sudo ./create-service-user.sh [new-user] [source-user]
#   new-user     defaults to twingcli
#   source-user  defaults to ubuntu -- whose authorized_keys gets mirrored

NEW_USER="${1:-twingcli}"
SOURCE_USER="${2:-ubuntu}"

if [[ $EUID -ne 0 ]]; then
  echo "run this with sudo" >&2
  exit 1
fi

if id "$NEW_USER" &>/dev/null; then
  echo "user $NEW_USER already exists, skipping creation"
else
  # --disabled-password --gecos "": fully non-interactive, no password login
  # for this account at all (SSH key only), regardless of the host's global
  # PasswordAuthentication setting.
  adduser --disabled-password --gecos "" "$NEW_USER"
fi

SOURCE_KEYS="/home/$SOURCE_USER/.ssh/authorized_keys"
if [[ ! -f "$SOURCE_KEYS" ]]; then
  echo "no authorized_keys found at $SOURCE_KEYS -- skipping key mirror" >&2
else
  install -d -m 700 -o "$NEW_USER" -g "$NEW_USER" "/home/$NEW_USER/.ssh"
  install -m 600 -o "$NEW_USER" -g "$NEW_USER" "$SOURCE_KEYS" "/home/$NEW_USER/.ssh/authorized_keys"
  echo "mirrored $SOURCE_KEYS -> /home/$NEW_USER/.ssh/authorized_keys"
fi

# The actual isolation mechanism: removing group/other access means nothing
# but the owner (and root) can traverse into either home directory, no
# matter what individual files inside allow.
chmod 700 "/home/$NEW_USER"
if [[ -d "/home/$SOURCE_USER" ]]; then
  chmod 700 "/home/$SOURCE_USER"
fi

echo
echo "=== verification ==="
echo "-- groups for $NEW_USER (should list nothing but its own private group):"
groups "$NEW_USER"
echo
echo "-- sudo check for $NEW_USER (should say 'not allowed'):"
sudo -l -U "$NEW_USER" 2>&1 || true
echo
echo "-- $NEW_USER reading /home/$SOURCE_USER (should be denied):"
sudo -u "$NEW_USER" ls "/home/$SOURCE_USER" 2>&1 || true
echo
echo "done. Test with: ssh $NEW_USER@<this-host>"
