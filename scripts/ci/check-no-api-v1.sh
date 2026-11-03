#!/usr/bin/env bash
# Fails when the app or its tests mention an /api/v1 request path.
#
# The app talks only to Silo's native /api/v2. Vendored server fixtures in
# src/contracts/v2/fixtures/ are server data, not request paths, so they are
# not scanned.
#
# Usage: scripts/ci/check-no-api-v1.sh [--root DIR]
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) root="$2"; shift 2 ;;
    *) echo "check-no-api-v1: unknown argument: $1" >&2; exit 2 ;;
  esac
done

cd "$root"
scan_dirs=()
for dir in app src test; do
  [[ -d "$dir" ]] && scan_dirs+=("$dir")
done
if [[ ${#scan_dirs[@]} -eq 0 ]]; then
  echo "check-no-api-v1: no app, src or test directory under ${root}" >&2
  exit 2
fi

pattern="api/v1|[\"']api[\"'], *[\"']v1[\"']"
matches="$(grep -rnIE --exclude-dir=fixtures "$pattern" "${scan_dirs[@]}" || true)"

if [[ -z "$matches" ]]; then
  echo "check-no-api-v1: ok"
  exit 0
fi

echo "error: /api/v1 request paths found; the app must call /api/v2:"
printf '%s\n' "$matches" | sed 's/^/  /'
exit 1
