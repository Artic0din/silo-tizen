#!/usr/bin/env bash
# Build the staged web app (npm run build), then package it as a signed .wgt with the Tizen CLI.
# Requires Node.js with dev dependencies installed (npm ci), Tizen Studio "Web CLI" on PATH,
# and a security profile in the developer environment.
# Produces dist/Silo.wgt (name from app/config.xml <name>Silo</name>).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/dist"
STAGE_DIR="${OUT_DIR}/wgt"
EXPECTED_BASENAME="Silo.wgt"
PROFILE="${TIZEN_SECURITY_PROFILE:-}"

if ! command -v tizen >/dev/null 2>&1; then
    echo "error: tizen CLI not found. Install Tizen Studio Web CLI and add tools/ide/bin to PATH." >&2
    exit 1
fi

if [[ -z "${PROFILE}" ]]; then
    echo "error: set TIZEN_SECURITY_PROFILE to your Certificate Manager profile name." >&2
    exit 1
fi

(cd "${ROOT_DIR}" && npm run build)

if [[ ! -f "${STAGE_DIR}/config.xml" ]]; then
    echo "error: missing ${STAGE_DIR}/config.xml after build" >&2
    exit 1
fi

# Tizen CLI 6.1: package the staged directory directly; avoid `tizen build-web` (known crash).
echo "Packaging web app from ${STAGE_DIR} with profile '${PROFILE}' (expected: ${EXPECTED_BASENAME})..."
tizen package -t wgt -s "${PROFILE}" -- "${STAGE_DIR}"

shopt -s nullglob
wgt_files=("${STAGE_DIR}"/*.wgt)
if [[ ${#wgt_files[@]} -eq 0 ]]; then
    echo "error: tizen package did not produce a .wgt in ${STAGE_DIR}" >&2
    exit 1
fi

for wgt in "${wgt_files[@]}"; do
    dest="${OUT_DIR}/$(basename "${wgt}")"
    mv -f "${wgt}" "${dest}"
    echo "WGT written: ${dest}"
done

if [[ ! -f "${OUT_DIR}/${EXPECTED_BASENAME}" ]]; then
    echo "warning: expected ${OUT_DIR}/${EXPECTED_BASENAME} but got: $(ls -1 "${OUT_DIR}"/*.wgt 2>/dev/null || echo none)" >&2
fi
