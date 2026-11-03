#!/usr/bin/env bash
set -euo pipefail
script="$(cd "$(dirname "$0")" && pwd)/check-no-api-v1.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
ok() { echo "ok: $1"; }
run() { "$script" --root "$tmp"; }

mkdir -p "$tmp/src/api" "$tmp/src/contracts/v2/fixtures" "$tmp/test/native" "$tmp/app" "$tmp/docs"
printf 'const path = "/api/v2/items";\n' > "$tmp/src/api/client.ts"
printf '{"notes": "the legacy /api/v1/settings endpoint"}\n' > "$tmp/src/contracts/v2/fixtures/settings.json"
printf 'The old /api/v1 API.\n' > "$tmp/docs/notes.md"
run > /dev/null || fail "a v2-only tree passes"
ok "v2 paths, vendored fixtures and docs pass"

for case in 'src/api/client.ts:const a = "/api/v1/health";' \
            "test/native/client.test.ts:const b = ['api', 'v1', 'items'].join(\"/\");" \
            'app/index.html:<link href="/api/v1/style">'; do
  file="${case%%:*}"
  printf '%s\n' "${case#*:}" > "$tmp/$file"
  out="$(run 2>&1)" && fail "$file passes with a v1 path"
  [[ "$out" == *"${file}:1:"* ]] || fail "$file is not listed: $out"
  printf 'clean\n' > "$tmp/$file"
  ok "$file v1 path fails"
done

rm -rf "$tmp/app" "$tmp/src" "$tmp/test"
out="$(run 2>&1)" && fail "a tree without sources passes"
[[ "$out" == *"no app, src or test directory"* ]] || fail "missing sources message: $out"
ok "a tree without sources fails"

echo "ALL PASS"
