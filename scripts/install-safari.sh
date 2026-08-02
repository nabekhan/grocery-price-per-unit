#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_app="$repo_dir/safari/build/Build/Products/Debug/Grocery Price Per Unit.app"
target_app="/Applications/Grocery Price Per Unit.app"
trash_root=$(/usr/bin/osascript -e 'POSIX path of (path to trash folder)')
backup_root="${trash_root%/}/Grocery-extension-install-backups"

if [ ! -d "$source_app" ]; then
  echo "Signed Safari build not found: $source_app" >&2
  echo "Run SAFARI_DEVELOPMENT_TEAM=YOUR_TEAM_ID npm run safari:build first." >&2
  exit 1
fi

# Refuse to install an unsigned or already-corrupt build.
/usr/bin/codesign --verify --deep --strict "$source_app"

source_appex="$source_app/Contents/PlugIns/Grocery Price Per Unit Extension.appex"
target_appex="$target_app/Contents/PlugIns/Grocery Price Per Unit Extension.appex"
lsregister="/System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister"

/usr/bin/osascript -e 'tell application "Safari" to quit' 2>/dev/null || true
/usr/bin/osascript -e 'tell application "Grocery Price Per Unit" to quit' 2>/dev/null || true

if [ -d "$target_appex" ]; then
  /usr/bin/pluginkit -r "$target_appex" 2>/dev/null || true
fi
/usr/bin/pluginkit -r "$source_appex" 2>/dev/null || true
"$lsregister" -u "$source_app" 2>/dev/null || true

# ditto merges app bundles, which can retain obsolete signed resources. Move the
# complete old bundle aside first so every installation starts from an empty path.
if [ -e "$target_app" ]; then
  /bin/mkdir -p "$backup_root"
  install_stamp=$(/bin/date '+%Y-%m-%d-%H%M%S')
  backup_app="$backup_root/Grocery Price Per Unit-$install_stamp.app"
  if [ -e "$backup_app" ]; then
    echo "Refusing to overwrite backup: $backup_app" >&2
    exit 1
  fi
  /bin/mv "$target_app" "$backup_app"
fi

/usr/bin/ditto "$source_app" "$target_app"
/usr/bin/codesign --verify --deep --strict "$target_app"
/usr/bin/pluginkit -a "$target_appex"
"$lsregister" -f -R -trusted "$target_app"
/usr/bin/open -a "$target_app"
/usr/bin/open -a Safari

echo "Installed and verified: $target_app"
