#!/usr/bin/env bash
# Write a release version (X.Y.Z) into the widget element of app/config.xml before packaging.
# Usage: scripts/ci/set-wgt-version.sh 1.2.0 [path to config.xml]
set -euo pipefail

version="${1:?usage: set-wgt-version.sh X.Y.Z [config.xml]}"
config="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/app/config.xml}"

if [[ ! "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: version must look like 1.2.0, got '${version}'." >&2
    exit 1
fi

# Only the <widget> element's own version attribute; <?xml version="1.0"?> is left alone.
sed -E -i.bak "s/(<widget [^>]*[[:space:]]version=\")[^\"]*\"/\1${version}\"/" "${config}"
rm -f "${config}.bak"

if ! grep -Eq "<widget [^>]*[[:space:]]version=\"${version//./\\.}\"" "${config}"; then
    echo "error: could not set version ${version} in ${config}." >&2
    exit 1
fi
echo "Set ${config} to version ${version}."
