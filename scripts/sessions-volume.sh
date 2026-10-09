#!/bin/bash
# Keeps skinnyai's chats on an encrypted volume (macOS). The volume is an
# encrypted sparse disk image that gets mounted over the sessions folder, so
# chats are unreadable on disk while it is ejected. See
# docs/encrypted-sessions.md.
#
#   sessions-volume.sh setup [--size 20g] [--delete-originals | --keep-originals]
#   sessions-volume.sh status | unlock | lock [--if-idle] | passphrase
#   sessions-volume.sh run [--keep-mounted] -- COMMAND...
#   sessions-volume.sh off | delete-originals [--yes]
#
# Where things are (override with environment variables):
#   SKINNY_HOME             ~/.skinny
#   SKINNY_SESSIONS_MOUNT   $SKINNY_HOME/sessions   (the mount point)
#   SKINNY_SESSIONS_IMAGE   $SKINNY_HOME/sessions.sparsebundle
#   SKINNY_SESSIONS_SIZE    20g (the most the image can grow to; it starts small)
#   SKINNY_SESSIONS_PASSPHRASE   use this passphrase instead of the Keychain's
#   SKINNY_SESSIONS_KEYCHAIN     keep the passphrase in this keychain file, not the login keychain
#
# The passphrase is random and lives in the login Keychain; it is never
# written to a file. The passphrase is always given to diskutil on stdin: with
# none, macOS would pop up its own password dialog and wait for it.
#
# Exit codes: 0 ok (for status: unlocked), 1 error, 3 status: locked,
# 4 not set up, 5 no passphrase available.

set -u

HOME_DIR="${SKINNY_HOME:-$HOME/.skinny}"
MOUNT="${SKINNY_SESSIONS_MOUNT:-$HOME_DIR/sessions}"
IMAGE="${SKINNY_SESSIONS_IMAGE:-$HOME_DIR/sessions.sparsebundle}"
SIZE="${SKINNY_SESSIONS_SIZE:-20g}"
SERVICE="skinnyai-sessions-volume"
MARKER=".skinny-encrypted"
USERS="$HOME_DIR/volume-users"
KEYCHAIN=()
[ -z "${SKINNY_SESSIONS_KEYCHAIN:-}" ] || KEYCHAIN=("$SKINNY_SESSIONS_KEYCHAIN")

die() {
  echo "sessions-volume: $1" >&2
  exit "${2:-1}"
}

# Mount points are listed by their real paths (/var is /private/var).
physical() {
  (cd -P "$1" 2>/dev/null && pwd -P)
}

is_mounted() {
  local real
  real="$(physical "$MOUNT")" || return 1
  mount | grep -F " on $real (" >/dev/null 2>&1
}

unlocked() {
  is_mounted && [ -e "$MOUNT/$MARKER" ]
}

configured() {
  [ -e "$IMAGE" ]
}

# 64 random hex characters.
new_passphrase() {
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

# What the user types or sees: groups of eight, any case, with or without dashes.
canonical() {
  printf '%s' "$1" | tr -d ' \n-' | tr 'A-F' 'a-f'
}

grouped() {
  printf '%s' "$1" | sed 's/\(.\{8\}\)/\1-/g; s/-$//'
}

# The passphrase: from the environment, the Keychain, or typed in a terminal.
passphrase() {
  if [ -n "${SKINNY_SESSIONS_PASSPHRASE:-}" ]; then
    canonical "$SKINNY_SESSIONS_PASSPHRASE"
    return 0
  fi
  local found
  if found="$(security find-generic-password -a "$IMAGE" -s "$SERVICE" -w ${KEYCHAIN[@]+"${KEYCHAIN[@]}"} 2>/dev/null)" && [ -n "$found" ]; then
    canonical "$found"
    return 0
  fi
  if [ -t 0 ] && [ -t 2 ]; then
    local typed
    printf 'Passphrase for the encrypted sessions: ' >&2
    read -r -s typed
    printf '\n' >&2
    canonical "$typed"
    return 0
  fi
  return 1
}

# `diskutil image` replaced hdiutil's image options; use whichever exists.
has_diskutil_image() {
  diskutil image 2>&1 | grep -q 'diskutil image'
}

create_image() {
  if has_diskutil_image; then
    printf '%s' "$1" | diskutil image --stdinpass create blank --encrypt --format UDSB --fs APFS --size "$SIZE" --volumeName SkinnyAI "$IMAGE" >/dev/null
  else
    printf '%s' "$1" | hdiutil create -size "$SIZE" -type SPARSEBUNDLE -fs APFS -encryption AES-256 -stdinpass -volname SkinnyAI "$IMAGE" >/dev/null
  fi
}

attach_image() {
  if has_diskutil_image; then
    printf '%s' "$1" | diskutil image --stdinpass attach --nobrowse --mountPoint "$MOUNT" "$IMAGE" >/dev/null
  else
    printf '%s' "$1" | hdiutil attach -stdinpass -nobrowse -mountpoint "$MOUNT" "$IMAGE" >/dev/null
  fi
}

# Until the volume is mounted, the mount point is an empty folder that nothing
# can write to, so a locked volume can't turn into chats saved in plain text.
ensure_mount_point() {
  if [ ! -d "$MOUNT" ]; then
    mkdir -p "$MOUNT" || die "can't make $MOUNT"
  fi
  chmod 700 "$MOUNT" 2>/dev/null
}

lock_mount_point() {
  chmod 500 "$MOUNT" 2>/dev/null
}

do_unlock() {
  configured || die "no encrypted sessions at $IMAGE (run: sessions-volume.sh setup)" 4
  if is_mounted; then
    unlocked || die "$MOUNT is mounted, but it isn't the encrypted sessions volume" 1
    return 0
  fi
  local pass
  pass="$(passphrase)" || die "no passphrase: it isn't in the Keychain, and there's no terminal to ask on" 5
  ensure_mount_point
  [ -z "$(ls -A "$MOUNT" 2>/dev/null)" ] || die "$MOUNT has files in it; a volume can't be mounted over them (move them aside first)" 1
  attach_image "$pass" || { lock_mount_point; die "couldn't unlock the volume (wrong passphrase or a damaged image)" 1; }
  unlocked || { do_lock_force; die "the volume mounted but is missing its marker file; ejected it" 1; }
}

eject() {
  diskutil eject "$MOUNT" >/dev/null 2>&1 || hdiutil detach "$MOUNT" >/dev/null 2>&1
}

do_lock_force() {
  eject
  lock_mount_point
}

live_users() {
  local count=0 file pid
  [ -d "$USERS" ] || { echo 0; return; }
  for file in "$USERS"/*; do
    [ -e "$file" ] || continue
    pid="$(basename "$file")"
    if kill -0 "$pid" 2>/dev/null; then
      count=$((count + 1))
    else
      rm -f "$file"
    fi
  done
  echo "$count"
}

do_lock() {
  configured || die "no encrypted sessions at $IMAGE" 4
  is_mounted || { lock_mount_point; return 0; }
  if [ "${1:-}" = "--if-idle" ] && [ "$(live_users)" != "0" ]; then
    return 0
  fi
  eject
  if is_mounted; then
    die "couldn't lock the volume: something is still using it (close skinnyai first)" 1
  fi
  lock_mount_point
}

do_status() {
  if ! configured; then
    echo "state=off"
    return 4
  fi
  if unlocked; then
    echo "state=unlocked"
    return 0
  fi
  echo "state=locked"
  return 3
}

do_setup() {
  local delete_originals="" assume=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --size) SIZE="${2:?--size needs a value, like 20g}"; shift ;;
      --delete-originals) delete_originals=yes ;;
      --keep-originals) delete_originals=no ;;
      *) die "unknown option $1" 1 ;;
    esac
    shift
  done
  [ ! -e "$IMAGE" ] || die "encrypted sessions are already set up ($IMAGE exists)" 1
  command -v diskutil >/dev/null 2>&1 || die "this needs macOS (diskutil)" 1
  is_mounted && die "$MOUNT is already a mounted volume" 1
  mkdir -p "$HOME_DIR" && chmod 700 "$HOME_DIR"

  local pass plain=""
  pass="$(new_passphrase)"
  create_image "$pass" || { rm -rf "$IMAGE"; die "couldn't create the encrypted image" 1; }
  if ! security add-generic-password -U -a "$IMAGE" -s "$SERVICE" -w "$pass" ${KEYCHAIN[@]+"${KEYCHAIN[@]}"} >/dev/null 2>&1; then
    rm -rf "$IMAGE"
    die "couldn't store the passphrase in the Keychain, so nothing was set up" 1
  fi

  # Chats already in the folder move aside; they're copied in once mounted.
  if [ -d "$MOUNT" ] && [ -n "$(ls -A "$MOUNT" 2>/dev/null)" ]; then
    plain="$MOUNT.plain-$(date +%Y%m%d%H%M%S)"
    mv "$MOUNT" "$plain" || { rm -rf "$IMAGE"; die "couldn't move $MOUNT aside" 1; }
  fi
  ensure_mount_point
  if ! attach_image "$pass"; then
    lock_mount_point
    [ -z "$plain" ] || { rmdir "$MOUNT" 2>/dev/null; mv "$plain" "$MOUNT"; }
    rm -rf "$IMAGE"
    die "couldn't mount the new volume; nothing changed" 1
  fi
  : > "$MOUNT/$MARKER"
  chmod 600 "$MOUNT/$MARKER"

  if [ -n "$plain" ]; then
    if ! cp -Rp "$plain/." "$MOUNT/" || ! diff -rq -x "$MARKER" "$plain" "$MOUNT" >/dev/null 2>&1; then
      do_lock_force
      rmdir "$MOUNT" 2>/dev/null
      mv "$plain" "$MOUNT"
      rm -rf "$IMAGE"
      die "the copy into the volume didn't check out, so nothing was changed; your chats are where they were" 1
    fi
    chmod 700 "$MOUNT" # cp -p copied the old folder's mode onto the volume's root
    if [ -z "$delete_originals" ] && [ -t 0 ] && [ -t 1 ]; then
      printf 'Copied your existing chats into the volume and checked them.\nDelete the unencrypted originals in %s now? [y/N] ' "$plain"
      read -r assume
      case "$assume" in y|Y|yes|YES) delete_originals=yes ;; *) delete_originals=no ;; esac
    fi
    if [ "$delete_originals" = "yes" ]; then
      rm -rf "$plain"
      plain=""
    fi
  fi

  echo "OK: encrypted sessions are set up and unlocked at $MOUNT"
  echo "PASSPHRASE: $(grouped "$pass")"
  echo "The passphrase is in your login Keychain. Save a copy in a password manager: without it (and the Keychain) the chats can't be read."
  if [ -n "$plain" ]; then
    echo "ORIGINALS: $plain"
    echo "The unencrypted originals are still there. Once you're satisfied with the volume, remove them: sessions-volume.sh delete-originals."
    echo "(Deleting a file doesn't guarantee its contents are gone from the disk, backups, or snapshots; FileVault covers that.)"
  fi
  echo "Add \"encryptedSessions\": true to ~/.skinny/config.json so skinnyai refuses to save chats while the volume is locked."
}

do_off() {
  configured || die "no encrypted sessions at $IMAGE" 4
  do_unlock
  local pass
  pass="$(passphrase)" || die "no passphrase available" 5
  local out="$MOUNT.decrypted-$(date +%Y%m%d%H%M%S)"
  mkdir -p "$out" && cp -Rp "$MOUNT/." "$out/" || die "couldn't copy the chats out; nothing changed" 1
  rm -f "$out/$MARKER"
  diff -rq -x "$MARKER" "$MOUNT" "$out" >/dev/null 2>&1 || die "the copy didn't check out; nothing changed (a copy is in $out)" 1
  do_lock || die "couldn't lock the volume to finish; the copy is in $out" 1
  chmod 700 "$MOUNT"
  cp -Rp "$out/." "$MOUNT/" && rm -rf "$out"
  chmod 700 "$MOUNT" # cp -p copied the temporary folder's mode onto it
  # Retire the image so this no longer counts as set up (and a new setup can't
  # overwrite the passphrase it needs): the image and its Keychain item are
  # renamed together, and are the user's to keep or delete.
  mv "$IMAGE" "$IMAGE.disabled" || die "the chats are back in $MOUNT, but couldn't rename the image $IMAGE" 1
  if security add-generic-password -U -a "$IMAGE.disabled" -s "$SERVICE" -w "$pass" ${KEYCHAIN[@]+"${KEYCHAIN[@]}"} >/dev/null 2>&1; then
    security delete-generic-password -a "$IMAGE" -s "$SERVICE" ${KEYCHAIN[@]+"${KEYCHAIN[@]}"} >/dev/null 2>&1
  fi
  echo "OK: the chats are back in $MOUNT, unencrypted. The old encrypted image is now $IMAGE.disabled (its passphrase is in the Keychain under that name); delete both when you're done with them."
  echo "Remove \"encryptedSessions\" from ~/.skinny/config.json."
}

do_delete_originals() {
  local found any=""
  for found in "$MOUNT".plain-*; do
    [ -e "$found" ] || continue
    any=yes
    if [ "${1:-}" != "--yes" ]; then
      printf 'Delete %s? [y/N] ' "$found" >&2
      read -r reply
      case "$reply" in y|Y|yes|YES) ;; *) continue ;; esac
    fi
    rm -rf "$found" && echo "Deleted $found"
  done
  [ -n "$any" ] || echo "No unencrypted originals to delete."
}

# Runs a command with the volume unlocked, and locks it again afterwards if
# nothing else started with `run` is still using it.
do_run() {
  local keep=""
  if [ "${1:-}" = "--keep-mounted" ]; then
    keep=yes
    shift
  fi
  [ "${1:-}" = "--" ] && shift
  [ $# -gt 0 ] || die "run needs a command: sessions-volume.sh run -- skinnyai ..." 1
  do_unlock || exit $?
  mkdir -p "$USERS" && : > "$USERS/$$"
  # shellcheck disable=SC2064
  trap "rm -f '$USERS/$$'; [ -z '$keep' ] && '$0' lock --if-idle >/dev/null 2>&1" EXIT
  trap 'exit 130' INT TERM
  "$@"
}

case "${1:-help}" in
  status) do_status ;;
  unlock) do_unlock ;;
  lock) shift; do_lock "${1:-}" ;;
  passphrase)
    pass="$(passphrase)" || die "no passphrase available" 5
    grouped "$pass"
    echo
    ;;
  setup) shift; do_setup "$@" ;;
  off) do_off ;;
  delete-originals) shift; do_delete_originals "${1:-}" ;;
  run) shift; do_run "$@" ;;
  help|--help|-h) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command '$1' (try: sessions-volume.sh help)" 1 ;;
esac
