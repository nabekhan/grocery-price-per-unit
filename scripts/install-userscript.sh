#!/bin/sh
set -eu

repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
source_userscript="$repo_dir/dist/userscript/Grocery Price Per Unit.user.js"

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /absolute/path/from/Userscripts/Grocery\ Price\ Per\ Unit.user.js" >&2
  exit 2
fi

destination=$1
case "$destination" in
  /*.user.js) ;;
  *) echo "Destination must be an absolute .user.js path: $destination" >&2; exit 2 ;;
esac
destination_basename=$(basename -- "$destination")
if [ "$destination_basename" != 'Grocery Price Per Unit.user.js' ]; then
  echo "Destination filename must be exactly Grocery Price Per Unit.user.js" >&2
  exit 2
fi

destination_parent=$(dirname -- "$destination")
if [ ! -d "$destination_parent" ]; then
  echo "Userscripts directory not found: $destination_parent" >&2
  exit 1
fi
destination_dir=$(CDPATH='' cd -- "$destination_parent" && pwd -P)
destination="$destination_dir/$destination_basename"
if [ -L "$destination" ]; then
  echo "Refusing to replace a symlink destination: $destination" >&2
  exit 1
fi

cd "$repo_dir"
npm run build
node scripts/verify-release.mjs --require-recorded

temporary_copy=$(mktemp "$destination_dir/.gppu-userscript-install.XXXXXX")
backup_path=''
mutation_started=0
committed=0
had_destination=0
installed_identity=''

file_identity() {
  case $(uname -s 2>/dev/null || true) in
    Darwin) /usr/bin/stat -f '%d:%i' "$1" ;;
    *) /usr/bin/stat -c '%d:%i' "$1" ;;
  esac
}

rollback() {
  original_status=$?
  trap - EXIT HUP INT TERM
  set +e
  [ ! -e "$temporary_copy" ] || /bin/rm -f "$temporary_copy"
  if [ "$mutation_started" -eq 1 ] && [ "$committed" -eq 0 ]; then
    current_identity=$(file_identity "$destination" 2>/dev/null || true)
    if [ -z "$installed_identity" ] || [ "$current_identity" != "$installed_identity" ] ||
      ! /usr/bin/cmp -s "$destination" "$source_userscript"; then
      echo "Install failed, but the destination changed outside this installer; preserving it and the backup for manual recovery: $destination" >&2
      [ "$original_status" -ne 0 ] || original_status=1
    elif [ "$had_destination" -eq 1 ]; then
      rollback_copy=$(mktemp "$destination_dir/.gppu-userscript-rollback.XXXXXX")
      if /bin/cp -p "$backup_path" "$rollback_copy" && /bin/mv "$rollback_copy" "$destination"; then
        echo "Install failed; restored previous userscript: $destination" >&2
      else
        /bin/rm -f "$rollback_copy"
        echo "Install failed and automatic rollback failed; preserved backup: $backup_path" >&2
        [ "$original_status" -ne 0 ] || original_status=1
      fi
    else
      if /bin/rm -f "$destination"; then
        echo "Install failed; removed unverified new userscript: $destination" >&2
      else
        echo "Install failed and could not remove the unverified new userscript: $destination" >&2
        [ "$original_status" -ne 0 ] || original_status=1
      fi
    fi
  fi
  exit "$original_status"
}

trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
/bin/cp "$source_userscript" "$temporary_copy"
/bin/chmod 0644 "$temporary_copy"
node scripts/verify-release.mjs --require-recorded --installed "$temporary_copy"

if [ -e "$destination" ] || [ -L "$destination" ]; then
  if [ -L "$destination" ]; then
    echo "Refusing to replace a symlink destination: $destination" >&2
    exit 1
  fi
  if [ ! -f "$destination" ]; then
    echo "Refusing to replace a non-file destination: $destination" >&2
    exit 1
  fi
  install_stamp=$(/bin/date '+%Y-%m-%d-%H%M%S')
  backup_path="$destination.backup-$install_stamp"
  if [ -e "$backup_path" ]; then
    echo "Refusing to overwrite backup: $backup_path" >&2
    exit 1
  fi
  had_destination=1
fi

if [ "$had_destination" -eq 1 ]; then
  if [ -L "$destination" ] || [ ! -f "$destination" ]; then
    echo "Userscript changed type while the installer was preparing it; refusing to overwrite: $destination" >&2
    exit 1
  fi
  /bin/mv -n "$destination" "$backup_path"
  if [ -e "$destination" ] || [ -L "$destination" ] || [ ! -f "$backup_path" ]; then
    echo "Could not atomically preserve the current userscript as a backup: $destination" >&2
    exit 1
  fi
  mutation_started=1
elif [ -e "$destination" ] || [ -L "$destination" ]; then
  echo "Userscript appeared while the installer was preparing it; refusing to overwrite: $destination" >&2
  exit 1
fi
/bin/mv -n "$temporary_copy" "$destination"
if [ -e "$temporary_copy" ] || [ ! -f "$destination" ] || [ -L "$destination" ]; then
  echo "Userscript appeared while the installer was committing; preserving it and any backup: $destination" >&2
  exit 1
fi
mutation_started=1
installed_identity=$(file_identity "$destination")
node scripts/verify-release.mjs --require-recorded --installed "$destination"
committed=1
trap - EXIT HUP INT TERM

echo "Installed and verified: $destination"
if [ -n "$backup_path" ]; then echo "Previous userscript backup: $backup_path"; fi
