#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
PACKAGE_NAME="edge-session-restore"

read_version() {
  grep -m1 '"version"' "$ROOT_DIR/package.json" | sed -E 's/.*"version":[[:space:]]*"([^"]+)".*/\1/'
}

cleanup_old_artifacts() {
  mkdir -p "$DIST_DIR"
  rm -f "$DIST_DIR/${PACKAGE_NAME}-v"*.zip
}

main() {
  local version zip_name
  local paths=()
  version="$(read_version)"

  if [ -z "$version" ]; then
    echo "Failed to read version from package.json" >&2
    exit 1
  fi

  cleanup_old_artifacts

  zip_name="${PACKAGE_NAME}-v${version}.zip"

  (
    cd "$ROOT_DIR"
    for candidate in manifest.json src icons README.md docs; do
      if [ -e "$candidate" ]; then
        paths+=("$candidate")
      fi
    done

    if [ "${#paths[@]}" -eq 0 ]; then
      echo "No package inputs found" >&2
      exit 1
    fi
    zip -r "$DIST_DIR/$zip_name" "${paths[@]}" >/dev/null
  )

  echo "$DIST_DIR/$zip_name"
}

main "$@"
