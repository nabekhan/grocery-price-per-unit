#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
project="$repo_dir/safari/Grocery Price Per Unit/Grocery Price Per Unit.xcodeproj"
derived="$repo_dir/safari/build"
marketing_version=2.0.5
build_number=25
resources="$repo_dir/safari/Grocery Price Per Unit/Shared (Extension)/Resources"

cd "$repo_dir"
npm run build
rsync -a --delete "$repo_dir/dist/extension/" "$resources/"

if [ -n "${SAFARI_DEVELOPMENT_TEAM:-}" ]; then
  xcodebuild -project "$project" -scheme "Grocery Price Per Unit (macOS)" \
    -configuration Debug -derivedDataPath "$derived" -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$SAFARI_DEVELOPMENT_TEAM" CODE_SIGN_IDENTITY="Apple Development" \
    MARKETING_VERSION="$marketing_version" CURRENT_PROJECT_VERSION="$build_number" build
else
  xcodebuild -project "$project" -scheme "Grocery Price Per Unit (macOS)" \
    -configuration Debug -derivedDataPath "$derived" CODE_SIGNING_ALLOWED=NO \
    MARKETING_VERSION="$marketing_version" CURRENT_PROJECT_VERSION="$build_number" build
fi
