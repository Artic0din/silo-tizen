#!/usr/bin/env bash
# Create the Tizen security profile CI signs with, and export its name as TIZEN_SECURITY_PROFILE.
# With TIZEN_AUTHOR_P12_B64 set, it uses the maintainer's Samsung author and distributor
# certificates from the repository secrets. Without them (fork pull requests), it makes a
# throwaway author certificate so packaging is still checked; that .wgt is never shipped.
# Prints signing=samsung or signing=throwaway to GITHUB_OUTPUT when it is set.
# The certificates stay in $RUNNER_TEMP/tizen-signing for packaging; the workflow removes them.
set -euo pipefail

if ! command -v tizen >/dev/null 2>&1; then
    echo "error: tizen CLI not found; run scripts/ci/install-tizen-cli.sh first." >&2
    exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sdk_root="$(cd "$(dirname "$(command -v tizen)")/../../.." && pwd)"
work_dir="${RUNNER_TEMP:-$(mktemp -d)}/tizen-signing"
mkdir -p "${work_dir}"
chmod 700 "${work_dir}"

find_one() {
    find "$@" 2>/dev/null | head -n 1 || true
}

# On Linux, `tizen security-profiles add` keeps passwords in the GNOME keyring through
# secret-tool, which a headless runner lacks, so signing later fails with "Invaild password".
# A profiles.xml password attribute that does not end in .pwd is instead decrypted with the
# CLI's own CipherUtil, so this script writes the profile with passwords in that form.
common_jar="$(find_one "${sdk_root}" -name 'org.tizen.common_*.jar')"
slf4j_jar="$(find_one "${sdk_root}" -name 'slf4j-api*.jar')"
if [[ -z "${common_jar}" || -z "${slf4j_jar}" ]]; then
    echo "error: could not find the Tizen common and slf4j jars under ${sdk_root}." >&2
    exit 1
fi
java_bin="${sdk_root}/jdk/bin"
if [[ ! -x "${java_bin}/javac" ]]; then
    java_bin="$(dirname "$(command -v javac)")"
fi
mkdir -p "${work_dir}/classes" # Java 8 javac does not create the -d directory.
"${java_bin}/javac" -nowarn -cp "${common_jar}" -d "${work_dir}/classes" "${script_dir}/EncryptProfilePassword.java"

encrypt_password() {
    printf '%s' "$1" | "${java_bin}/java" -cp "${work_dir}/classes:${common_jar}:${slf4j_jar}" \
        EncryptProfilePassword 2>/dev/null
}

# Distributor ordinal 0 is the author certificate, 1 the distributor, 2 an unused second one.
write_profile() {
    PROFILE="$1" AUTHOR_KEY="$2" AUTHOR_PASSWORD="$3" DISTRIBUTOR_KEY="$4" DISTRIBUTOR_PASSWORD="$5" \
        python3 -I - "${work_dir}/profiles.xml" <<'PY'
import os
import sys
from xml.sax.saxutils import quoteattr

name = quoteattr(os.environ["PROFILE"])
items = [
    (0, os.environ["AUTHOR_KEY"], os.environ["AUTHOR_PASSWORD"]),
    (1, os.environ["DISTRIBUTOR_KEY"], os.environ["DISTRIBUTOR_PASSWORD"]),
    (2, "", ""),
]
lines = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    f'<profiles active={name} version="3.1">',
    f"  <profile name={name}>",
]
for ordinal, key, password in items:
    lines.append(
        f'    <profileitem ca="" distributor="{ordinal}" key={quoteattr(key)} '
        f'password={quoteattr(password)} rootca=""/>'
    )
lines += ["  </profile>", "</profiles>", ""]
with open(sys.argv[1], "w", encoding="utf-8") as profiles:
    profiles.write("\n".join(lines))
PY
    chmod 600 "${work_dir}/profiles.xml"
}

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
    author_password="$(encrypt_password "${TIZEN_AUTHOR_PASSWORD}")"
    distributor_password="$(encrypt_password "${TIZEN_DISTRIBUTOR_PASSWORD}")"
    write_profile "${profile}" "${work_dir}/author.p12" "${author_password}" \
        "${work_dir}/distributor.p12" "${distributor_password}"
else
    profile="silo-ci-throwaway"
    signing="throwaway"
    password="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
    tizen certificate -a silo-ci -p "${password}" -f silo-ci -- "${work_dir}"
    # The CLI's output directory varies by version; a missing search root is not an error.
    author_p12="$(find_one "${work_dir}" "${HOME}"/tizen-*data/keystore -name silo-ci.p12)"
    if [[ -z "${author_p12}" ]]; then
        echo "error: tizen certificate did not create silo-ci.p12." >&2
        exit 1
    fi
    # The SDK's public default distributor certificate and its documented password.
    distributor_p12="${sdk_root}/tools/certificate-generator/certificates/distributor/tizen-distributor-signer.p12"
    if [[ ! -f "${distributor_p12}" ]]; then
        echo "error: ${distributor_p12} is missing from the SDK." >&2
        exit 1
    fi
    author_password="$(encrypt_password "${password}")"
    distributor_password="$(encrypt_password "tizenpkcs12passfordsigner")"
    write_profile "${profile}" "${author_p12}" "${author_password}" "${distributor_p12}" "${distributor_password}"
fi

# `tizen package` reads profiles only from the file named in its CLI configuration.
tizen cli-config "profiles.path=${work_dir}/profiles.xml"

echo "Signing with the ${signing} profile."
if [[ -n "${GITHUB_ENV:-}" ]]; then
    echo "TIZEN_SECURITY_PROFILE=${profile}" >> "${GITHUB_ENV}"
fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "signing=${signing}" >> "${GITHUB_OUTPUT}"
fi
