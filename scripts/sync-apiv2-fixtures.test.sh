#!/usr/bin/env bash
# Runs scripts/sync-apiv2-fixtures.sh against a throwaway server repository and
# a copy of this repository's contract layout, so it never touches this checkout.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

# The names in one of the script's arrays, one per line.
array_names() {
  sed -n "/^$1=(/,/^)/p" "$here/sync-apiv2-fixtures.sh" | sed -n 's/^  \([a-z0-9_.]*\)$/\1/p'
}
selected="$(array_names SELECTED)"
keys="$(array_names SETTINGS_KEYS)"
sets="$(array_names SETTINGS_OPTION_SETS)"
[ -n "$selected" ] && [ -n "$keys" ] && [ -n "$sets" ] || fail "could not read the script's arrays"

client="$tmp/client"
dest="$client/src/contracts/v2/fixtures"
mkdir -p "$client/scripts" "$dest"
cp "$here/sync-apiv2-fixtures.sh" "$client/scripts/"
sync="$client/scripts/sync-apiv2-fixtures.sh"

server="$tmp/server"
fixtures="$server/contracts/api/v2/fixtures"
mkdir -p "$fixtures" "$server/contracts/settings/v1"
git -C "$server" init -q
commit() {
  git -C "$server" add -A
  git -C "$server" -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false \
    commit -q -m "$1"
  git -C "$server" rev-parse HEAD
}

while IFS= read -r name; do
  printf '{"fixture":"%s"}\n' "$name" > "$fixtures/$name.json"
done <<< "$selected"
# Pad the listing well past a pipe buffer. A lookup that pipes the listing
# into grep -q under pipefail fails for names near the top of this list.
i=0
while [ "$i" -lt 3000 ]; do
  printf '{}\n' > "$fixtures/zz_padding_fixture_with_a_long_enough_name_$i.json"
  i=$((i + 1))
done
# A manifest with an unselected definition first and one unselected option set.
write_manifest() {
  {
    printf '{"api_version":1,"revision":%s,"definitions":[{"key":"not.selected"}' "$1"
    printf '%s\n' "$2" | sed 's/.*/,{"key":"&"}/' | tr -d '\n'
    printf '],"option_sets":{"unused":{}'
    printf '%s\n' "$sets" | sed 's/.*/,"&":{"type":"x"}/' | tr -d '\n'
    printf '}}\n'
  } > "$server/contracts/settings/v1/manifest.json"
}
write_manifest 24 "$keys"
base="$(commit base)"

# Must fail and leave the fixture directory exactly as it was.
expect_reject() {
  local desc="$1" pattern="$2"; shift 2
  local before after status=0 out
  before="$(cd "$dest" && ls -A && cat ./*.json 2>/dev/null)"
  out="$(SILO_SERVER_REPO="$server" "$sync" "$@" 2>&1)" || status=$?
  [ "$status" -ne 0 ] || fail "$desc: expected a non-zero exit"
  printf '%s\n' "$out" | grep -qF -- "$pattern" || fail "$desc: expected '$pattern' in: $out"
  after="$(cd "$dest" && ls -A && cat ./*.json 2>/dev/null)"
  [ "$before" = "$after" ] || fail "$desc: the fixture directory changed"
  ok "$desc"
}

status=0
env -u SILO_SERVER_REPO "$sync" "$base" >/dev/null 2>&1 || status=$?
[ "$status" -eq 2 ] || fail "no SILO_SERVER_REPO: expected exit 2, got $status"
ok "requires SILO_SERVER_REPO"

printf '{"stale":true}\n' > "$dest/dropped_from_selected.json"
SILO_SERVER_REPO="$server" "$sync" "$base" >/dev/null
while IFS= read -r name; do
  cmp -s "$fixtures/$name.json" "$dest/$name.json" || fail "$name.json differs from the server copy"
done <<< "$selected"
ok "vendors every SELECTED fixture despite a listing larger than a pipe buffer"
[ ! -e "$dest/dropped_from_selected.json" ] || fail "stale fixture was kept"
[ ! -e "$dest/zz_padding_fixture_with_a_long_enough_name_0.json" ] || fail "an unselected server fixture was vendored"
ok "deletes stale fixtures and vendors nothing outside SELECTED"
settings="$dest/settings_contract_ok.json"
[ "$(jq -r '[.definitions[].key] | join(" ")' "$settings")" = "$(printf '%s\n' "$keys" | paste -sd' ' -)" ] \
  || fail "settings subset keys are: $(jq -c '[.definitions[].key]' "$settings")"
[ "$(jq -r '.option_sets | keys | join(" ")' "$settings")" = "$(printf '%s\n' "$sets" | sort | paste -sd' ' -)" ] \
  || fail "settings option sets are: $(jq -c '.option_sets | keys' "$settings")"
[ "$(jq '.revision' "$settings")" = 24 ] || fail "settings revision not copied"
ok "writes only the selected Settings definitions and option sets, in manifest order"
[ "$(cat "$client/src/contracts/v2/SOURCE")" = "$base" ] || fail "SOURCE is not the server commit"
ok "records the server commit in SOURCE"

first_key="$(printf '%s\n' "$keys" | head -n 1)"
write_manifest 25 "$(printf '%s\n' "$keys" | sed 1d)"
missing_key="$(commit "drop $first_key")"
expect_reject "manifest loses a SETTINGS_KEYS definition" "of the $(printf '%s\n' "$keys" | grep -c .) SETTINGS_KEYS" "$missing_key"

first_selected="$(printf '%s\n' "$selected" | head -n 1)"
write_manifest 24 "$keys"
git -C "$server" rm -q "contracts/api/v2/fixtures/$first_selected.json"
removed="$(commit "remove $first_selected")"
expect_reject "server drops a SELECTED fixture" "$first_selected.json does not exist" "$removed"

expect_reject "unknown server ref" "does not name a commit" "no-such-ref"

echo "ALL PASS"
