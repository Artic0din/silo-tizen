#!/usr/bin/env bash
# Package the Samsung TV web app as a signed .wgt using the Tizen CLI.
# Requires Tizen Studio "Web CLI" on PATH and a security profile in the developer environment.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${ROOT_DIR}/app"
OUT_DIR="${ROOT_DIR}/dist"
PROFILE="${TIZEN_SECURITY_PROFILE:-}"

if ! command -v tizen >/dev/null 2>&1; then
    echo "error: tizen CLI not found. Install Tizen Studio Web CLI and add tools/ide/bin to PATH." >&2
    exit 1
fi

if [[ -z "${PROFILE}" ]]; then
    echo "error: set TIZEN_SECURITY_PROFILE to your Certificate Manager profile name." >&2
    exit 1
fi

if [[ ! -f "${APP_DIR}/config.xml" ]]; then
    echo "error: missing ${APP_DIR}/config.xml" >&2
    exit 1
fi

mkdir -p "${OUT_DIR}"

# Tizen CLI 6.1: package source directly; avoid `tizen build-web` (known crash).
echo "Packaging web app from ${APP_DIR} with profile '${PROFILE}'..."
tizen package -t wgt -s "${PROFILE}" -- "${APP_DIR}"

shopt -s nullglob
wgt_files=("${APP_DIR}"/*.wgt)
if [[ ${#wgt_files[@]} -eq 0 ]]; then
    echo "error: tizen package did not produce a .wgt in ${APP_DIR}" >&2
    exit 1
fi

for wgt in "${wgt_files[@]}"; do
    mv -f "${wgt}" "${OUT_DIR}/"
    echo "WGT written: ${OUT_DIR}/$(basename "${wgt}")"
done
