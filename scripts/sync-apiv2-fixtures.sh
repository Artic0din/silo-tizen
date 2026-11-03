#!/usr/bin/env bash
# Vendor the silo-server API v2 contract fixtures this client consumes, at an
# explicit server commit, and record that commit in src/contracts/v2/SOURCE:
#
#   src/contracts/v2/fixtures/*.json           <- contracts/api/v2/fixtures (SELECTED bodies)
#   src/contracts/v2/fixtures/settings_contract_ok.json
#                                              <- contracts/settings/v1/manifest.json
#                                                 (the SETTINGS_KEYS definitions and
#                                                 SETTINGS_OPTION_SETS, in manifest order)
#
# Every byte comes from `git show <commit>:<path>` in the server repository,
# never from its working tree, so SOURCE always reproduces the vendored files.
# The OpenAPI document is never vendored. Any other *.json in the fixture
# directory is stale and the script deletes it.
#
# Usage: scripts/sync-apiv2-fixtures.sh <server-ref>
#   <server-ref>      any commit-ish the server repository resolves (a full
#                     commit is preferred over a moving branch)
#   SILO_SERVER_REPO  path to a silo-server checkout (required)
#
# Afterwards run npm test: the decoders and fakes read these fixtures.
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <server-ref>   (server repository: \$SILO_SERVER_REPO)" >&2
  exit 2
fi
REF="$1"
SERVER="${SILO_SERVER_REPO:-}"
[ -n "$SERVER" ] || { echo "set SILO_SERVER_REPO to a silo-server checkout" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

CONTRACT="$ROOT/src/contracts/v2"
DEST="$CONTRACT/fixtures"
FIXTURES_SRC="contracts/api/v2/fixtures"
MANIFEST_SRC="contracts/settings/v1/manifest.json"
SETTINGS_FIXTURE="settings_contract_ok"

# Server fixtures this client's decoders and fakes read.
SELECTED=(
  authentication_required
  cancel_device_login_not_found
  cancel_device_login_ok
  get_catalog_filters_ok
  get_catalog_item_ok
  get_catalog_search_capabilities_ok
  get_device_login_capability_ok
  get_library_collections_ok
  get_library_section_items_ok
  get_system_info_ok
  get_watch_state_ok
  get_watch_trickplay_ok
  list_auth_providers_ok
  list_catalog_item_versions_ok
  list_catalog_items_ok
  list_effective_settings_ok
  list_home_sections_ok
  list_library_sections_ok
  list_profiles_ok
  list_season_episodes_ok
  list_series_seasons_ok
  list_series_seasons_without_artwork
  login_account_required
  login_invalid_credentials
  login_ok
  login_password_required
  playback_capability_available
  playback_capability_unconfigured
  playback_installation_changed
  playback_progress_applied
  playback_progress_conflict
  playback_progress_stale
  playback_start_opaque_ids
  playback_stop_completed
  playback_stop_replayed
  poll_device_login_ok
  poll_device_login_opened
  profile_verification_required
  query_catalog_items_ok
  query_catalog_letters_ok
  rate_limited
  refresh_session_ok
  refresh_session_provider_unavailable
  refresh_session_revoked
  start_device_login_ok
  token_refresh_required
  user_libraries
  verify_profile_pin_ok
  verify_profile_pin_wrong
)

# The Settings manifest subset in settings_contract_ok.json (src/contracts/v2/README.md).
SETTINGS_KEYS=(
  ui.disabled_library_ids
  playback.audio_language
  playback.preferred_quality
  playback.max_bitrate_kbps
  player.video_skip_back_seconds
  player.video_skip_forward_seconds
  ui.title_art
)
SETTINGS_OPTION_SETS=(
  playback_audio_languages
)

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
git -C "$SERVER" rev-parse --git-dir >/dev/null 2>&1 \
  || { echo "not a git repository: $SERVER (set SILO_SERVER_REPO)" >&2; exit 1; }
SHA="$(git -C "$SERVER" rev-parse --verify --quiet "$REF^{commit}")" \
  || { echo "server ref $REF does not name a commit in $SERVER" >&2; exit 1; }

show() { git -C "$SERVER" show "$SHA:$1"; }
git -C "$SERVER" cat-file -e "$SHA:$MANIFEST_SRC" 2>/dev/null \
  || { echo "$MANIFEST_SRC does not exist at $SHA" >&2; exit 1; }

published="$(git -C "$SERVER" ls-tree -r --name-only "$SHA" -- "$FIXTURES_SRC/" | sed "s|^$FIXTURES_SRC/||")"
# A here-string, not a pipe: grep -q exits on the first match, and under
# pipefail a writer still filling the pipe would fail the lookup.
is_published() { grep -qxF -- "$1" <<< "$published"; }
in_list() { local needle="$1" n; shift; for n in "$@"; do [ "$n" = "$needle" ] && return 0; done; return 1; }

# Check everything before writing anything, so a refused run leaves the directory as it was.
for name in "${SELECTED[@]}"; do
  is_published "$name.json" || { echo "$FIXTURES_SRC/$name.json does not exist at $SHA" >&2; exit 1; }
done
manifest="$(show "$MANIFEST_SRC")"
keys_json="$(printf '%s\n' "${SETTINGS_KEYS[@]}" | jq -R . | jq -s .)"
sets_json="$(printf '%s\n' "${SETTINGS_OPTION_SETS[@]}" | jq -R . | jq -s .)"
settings="$(jq --argjson keys "$keys_json" --argjson sets "$sets_json" '
  {api_version, revision,
   definitions: [.definitions[] | select(.key as $k | $keys | index($k))],
   option_sets: (.option_sets | with_entries(select(.key as $k | $sets | index($k))))}' <<< "$manifest")"
found="$(jq '.definitions | length' <<< "$settings")"
[ "$found" -eq "${#SETTINGS_KEYS[@]}" ] \
  || { echo "$MANIFEST_SRC at $SHA has $found of the ${#SETTINGS_KEYS[@]} SETTINGS_KEYS" >&2; exit 1; }
[ "$(jq '.option_sets | length' <<< "$settings")" -eq "${#SETTINGS_OPTION_SETS[@]}" ] \
  || { echo "$MANIFEST_SRC at $SHA lacks one of the SETTINGS_OPTION_SETS" >&2; exit 1; }

mkdir -p "$DEST"
removed=0
for file in "$DEST"/*.json; do
  [ -e "$file" ] || continue
  name="$(basename "$file" .json)"
  [ "$name" = "$SETTINGS_FIXTURE" ] && continue
  in_list "$name" "${SELECTED[@]}" && continue
  rm "$file"
  echo "removed stale $name.json (not in SELECTED)"
  removed=$((removed + 1))
done
for name in "${SELECTED[@]}"; do
  show "$FIXTURES_SRC/$name.json" > "$DEST/$name.json"
done
printf '%s\n' "$settings" > "$DEST/$SETTINGS_FIXTURE.json"
printf '%s\n' "$SHA" > "$CONTRACT/SOURCE"

manifest_sha="$(printf '%s\n' "$manifest" | shasum -a 256 | cut -d' ' -f1)"
revision="$(jq '.revision' <<< "$manifest")"
echo "vendored ${#SELECTED[@]} API v2 fixtures and the Settings subset from $SHA ($REF); removed $removed stale"
echo "Settings manifest revision $revision, SHA-256 $manifest_sha: update src/contracts/v2/README.md if either changed"
