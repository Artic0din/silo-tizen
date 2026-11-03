#!/usr/bin/env bash
# Create the Tizen security profile CI signs with, and export its name as TIZEN_SECURITY_PROFILE.
# With TIZEN_AUTHOR_P12_B64 set, it uses the maintainer's Samsung author and distributor
# certificates from the repository secrets. Without them (fork pull requests), it makes a
# throwaway author certificate so packaging is still checked; that .wgt is never shipped.
# Prints signing=samsung or signing=throwaway to GITHUB_OUTPUT when it is set.
set -euo pipefail

if ! command -v tizen >/dev/null 2>&1; then
    echo "error: tizen CLI not found; run scripts/ci/install-tizen-cli.sh first." >&2
    exit 1
fi

work_dir="${RUNNER_TEMP:-$(mktemp -d)}/tizen-signing"
mkdir -p "${work_dir}"
chmod 700 "${work_dir}"

if [[ -n "${TIZEN_AUTHOR_P12_B64:-}" ]]; then
    for name in TIZEN_AUTHOR_PASSWORD TIZEN_DISTRIBUTOR_P12_B64 TIZEN_DISTRIBUTOR_PASSWORD; do
        if [[ -z "${!name:-}" ]]; then
            echo "error: ${name} is not set; all four signing secrets are required." >&2
            exit 1
        fi
    done
    profile="silo-release"
    signing="samsung"
    printf '%s' "${TIZEN_AUTHOR_P12_B64}" | base64 --decode > "${work_dir}/author.p12"
    printf '%s' "${TIZEN_DISTRIBUTOR_P12_B64}" | base64 --decode > "${work_dir}/distributor.p12"
    tizen security-profiles add -f -A -n "${profile}" \
        -a "${work_dir}/author.p12" -p "${TIZEN_AUTHOR_PASSWORD}" \
        -d "${work_dir}/distributor.p12" -dp "${TIZEN_DISTRIBUTOR_PASSWORD}"
else
    profile="silo-ci-throwaway"
    signing="throwaway"
    password="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
    tizen certificate -a silo-ci -p "${password}" -f silo-ci -- "${work_dir}"
    author_p12="$(find "${work_dir}" "${HOME}"/tizen-*data/keystore -name silo-ci.p12 2>/dev/null | head -n 1)"
    if [[ -z "${author_p12}" ]]; then
        echo "error: tizen certificate did not create silo-ci.p12." >&2
        exit 1
    fi
    tizen security-profiles add -f -A -n "${profile}" -a "${author_p12}" -p "${password}"
fi

# `tizen package` reads profiles only from the file named in its CLI configuration.
profiles_xml="$(find "${HOME}"/tizen-*data/profile -name profiles.xml 2>/dev/null | head -n 1)"
if [[ -z "${profiles_xml}" ]]; then
    echo "error: tizen security-profiles add did not write profiles.xml." >&2
    exit 1
fi
tizen cli-config "profiles.path=${profiles_xml}"

echo "Signing with the ${signing} profile."
if [[ -n "${GITHUB_ENV:-}" ]]; then
    echo "TIZEN_SECURITY_PROFILE=${profile}" >> "${GITHUB_ENV}"
fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "signing=${signing}" >> "${GITHUB_OUTPUT}"
fi
