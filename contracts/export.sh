#!/bin/bash
# Versioned archive of the contracts, for the tests of local_pronoteio:
#   bash contracts/export.sh [output dir]   → <dir>/pronoteio-contracts-<version>.tar.gz (+ .sha256)
# The archive holds contracts/ (schemas, fixtures, requests.json) and a MANIFEST.json (version, commit, date, files).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:-$root/build}"
version="$(sed -n 's/^ *"version" *: *"\([^"]*\)".*/\1/p' "$root/package.json" | head -n 1)"
commit="$(git -C "$root" rev-parse HEAD 2>/dev/null || echo unknown)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$out" "$work/pronoteio-contracts-$version"
cp -R "$root/contracts/." "$work/pronoteio-contracts-$version/"
rm -f "$work/pronoteio-contracts-$version/export.sh"
files="$(cd "$work/pronoteio-contracts-$version" && find . -type f | sort | sed 's|^\./||' | awk '{printf "%s\"%s\"", (NR>1?",":""), $0}')"
printf '{"name":"pronoteio-contracts","version":"%s","commit":"%s","date":"%s","files":[%s]}\n' \
  "$version" "$commit" "$(date -u '+%FT%TZ')" "$files" >"$work/pronoteio-contracts-$version/MANIFEST.json"
archive="$out/pronoteio-contracts-$version.tar.gz"
tar -czf "$archive" -C "$work" "pronoteio-contracts-$version"
(cd "$out" && sha256sum "$(basename "$archive")" >"$(basename "$archive").sha256")
echo "$archive"
