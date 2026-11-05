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
rows_keys="$(array_names SETTINGS_ROWS_KEYS)"
rows_sets="$(array_names SETTINGS_ROWS_OPTION_SETS)"
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
    printf '%s\n' "$2" "$rows_keys" | sed '/^$/d; s/.*/,{"key":"&"}/' | tr -d '\n'
    printf '],"option_sets":{"unused":{}'
    printf '%s\n' "$sets" "$rows_sets" | sed '/^$/d; s/.*/,"&":{"type":"x"}/' | tr -d '\n'
    printf '}}\n\n'
  } > "$server/contracts/settings/v1/manifest.json"
}
manifest_order="$(printf '%s\n' "$keys" | tail -r 2>/dev/null || printf '%s\n' "$keys" | tac)"
write_manifest 24 "$manifest_order"
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
printf '{"remove_failed_supported":true}\n' > "$dest/request_status_ok.json"
printf '%s\n' "0000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" > "$client/src/contracts/v2/SOURCE"
mkdir -p "$client/docs"
printf 'Pinned to 0000000.\n' > "$client/docs/pin.md"
out="$(SILO_SERVER_REPO="$server" "$sync" "$base")"
while IFS= read -r name; do
  cmp -s "$fixtures/$name.json" "$dest/$name.json" || fail "$name.json differs from the server copy"
done <<< "$selected"
ok "vendors every SELECTED fixture despite a listing larger than a pipe buffer"
[ ! -e "$dest/dropped_from_selected.json" ] || fail "stale fixture was kept"
[ -f "$dest/request_status_ok.json" ] || fail "request_status_ok was deleted before SOURCE includes it"
[ ! -e "$dest/zz_padding_fixture_with_a_long_enough_name_0.json" ] || fail "an unselected server fixture was vendored"
ok "deletes stale fixtures and vendors nothing outside SELECTED"
settings="$dest/settings_contract_ok.json"
[ "$(jq -r '[.definitions[].key] | join(" ")' "$settings")" = "$(printf '%s\n' "$manifest_order" | paste -sd' ' -)" ] \
  || fail "settings subset keys are: $(jq -c '[.definitions[].key]' "$settings")"
[ "$(jq -r '.option_sets | keys | join(" ")' "$settings")" = "$(printf '%s\n' "$sets" | sort | paste -sd' ' -)" ] \
  || fail "settings option sets are: $(jq -c '.option_sets | keys' "$settings")"
[ "$(jq '.revision' "$settings")" = 24 ] || fail "settings revision not copied"
ok "writes only the selected Settings definitions and option sets, in manifest order"
rows="$dest/settings_rows_216.json"
[ -f "$rows" ] || fail "Settings rows fixture was not generated"
[ "$(jq -r '[.definitions[].key] | join(" ")' "$rows")" = "$(printf '%s\n' "$rows_keys" | paste -sd' ' -)" ] || fail "Settings rows definitions differ"
[ "$(jq -r '.option_sets | keys | join(" ")' "$rows")" = "$rows_sets" ] || fail "Settings rows option sets differ"
cp "$rows" "$tmp/rows-before.json"
printf '{"stale":true}\n' > "$rows"
SILO_SERVER_REPO="$server" "$sync" "$base" >/dev/null
cmp -s "$tmp/rows-before.json" "$rows" || fail "refresh did not reproduce the Settings rows fixture"
ok "refresh regenerates the Settings rows fixture instead of deleting or preserving stale bytes"
[ "$(cat "$client/src/contracts/v2/SOURCE")" = "$base" ] || fail "SOURCE is not the server commit"
ok "records the server commit in SOURCE"
expected_sha="$(git -C "$server" show "$base:contracts/settings/v1/manifest.json" | shasum -a 256 | cut -d' ' -f1)"
printf '%s\n' "$out" | grep -qF "SHA-256 $expected_sha" || fail "manifest digest is not the blob's: $out"
ok "reports the manifest blob's own SHA-256"
printf '%s\n' "$out" | grep -qF "docs/pin.md" || fail "the stale pin in docs/pin.md was not reported: $out"
ok "lists files that still cite the previous pin"

first="$(printf '%s\n' "$keys" | head -n 1)"
write_manifest 24 "$(printf '%s\n%s\n' "$first" "$(printf '%s\n' "$keys" | sed 1d | sed 1d)" ; printf '%s\n' "$first")"
duplicate="$(commit "repeat $first, drop the second key")"
expect_reject "a repeated key cannot stand in for a missing one" "exactly once" "$duplicate"

first_key="$(printf '%s\n' "$keys" | head -n 1)"
write_manifest 25 "$(printf '%s\n' "$keys" | sed 1d)"
missing_key="$(commit "drop $first_key")"
expect_reject "manifest loses a SETTINGS_KEYS definition" "exactly once" "$missing_key"

saved_rows_keys="$rows_keys"
rows_keys="$(printf '%s\n' "$rows_keys" | sed 1d)"
write_manifest 24 "$keys"
missing_row="$(commit "drop a Settings row definition")"
expect_reject "manifest loses a Settings rows definition" "exactly once" "$missing_row"
rows_keys="$saved_rows_keys"
saved_rows_sets="$rows_sets"
rows_sets=""
write_manifest 24 "$keys"
missing_rows_set="$(commit "drop the Settings rows option set")"
expect_reject "manifest loses a Settings rows option set" "lacks one of the Settings option sets" "$missing_rows_set"
rows_sets="$saved_rows_sets"

first_selected="$(printf '%s\n' "$selected" | head -n 1)"
write_manifest 24 "$keys"
git -C "$server" rm -q "contracts/api/v2/fixtures/$first_selected.json"
removed="$(commit "remove $first_selected")"
expect_reject "server drops a SELECTED fixture" "$first_selected.json does not exist" "$removed"

expect_reject "unknown server ref" "does not name a commit" "no-such-ref"

echo "ALL PASS"
