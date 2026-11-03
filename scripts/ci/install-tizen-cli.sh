#!/usr/bin/env bash
# Install the pinned Tizen SDK Web CLI on an Ubuntu CI runner and put `tizen` on the PATH.
# Usage: scripts/ci/install-tizen-cli.sh [install directory, default ~/tizen-sdk]
set -euo pipefail

readonly INSTALLER_URL="https://download.tizen.org/sdk/Installer/tizen-sdk_10.0/web-cli_Tizen_SDK_10.0_ubuntu-64.bin"
readonly INSTALLER_SHA256="65d2a569cbf0351dca4b94254f2c642d49195ac4964e08a76b4eaabc9ce4bed0"
install_dir="${1:-${HOME}/tizen-sdk}"

installer="$(mktemp)"
trap 'rm -f "${installer}"' EXIT
curl -fsSL --retry 3 -o "${installer}" "${INSTALLER_URL}"
echo "${INSTALLER_SHA256}  ${installer}" | sha256sum --check --quiet -
chmod +x "${installer}"
"${installer}" --accept-license "${install_dir}"

cli_dir="${install_dir}/tools/ide/bin"
if [[ ! -x "${cli_dir}/tizen" ]]; then
    echo "error: the installer did not create ${cli_dir}/tizen." >&2
    exit 1
fi
if [[ -n "${GITHUB_PATH:-}" ]]; then
    echo "${cli_dir}" >> "${GITHUB_PATH}"
fi
"${cli_dir}/tizen" version
