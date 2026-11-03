#!/usr/bin/env python3
"""Report upstream feature changes that FEATURES.md has not caught up with.

FEATURES.md compares this app with the Apple TV and Android TV apps. It is a
snapshot, so this script compares the upstream repositories with the state they
were in when FEATURES.md was last reviewed, which is recorded in
docs/parity/upstream-snapshot.json:

- Android TV: every row of silo-android's FEATURES.md with its TV status.
- Apple TV: the tvOS-only source files in silo-apple (no feature list exists
  there, so new or removed tvOS screens are the signal).

    parity-drift.py check [--report FILE]   print or write the drift report; empty means none
    parity-drift.py update                  record the current upstream state in the snapshot

Run `update` in the pull request that brings FEATURES.md up to date.
GITHUB_TOKEN or GH_TOKEN, when set, is sent to the GitHub API to avoid its anonymous rate limit.
"""

import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / "docs" / "parity" / "upstream-snapshot.json"
ANDROID_FEATURES = "https://raw.githubusercontent.com/Silo-Server/silo-android/main/FEATURES.md"
APPLE_TREE = "https://api.github.com/repos/Silo-Server/silo-apple/git/trees/main?recursive=1"
TVOS_PATH = re.compile(r"^iosApp/(?:.*/tvOS/.*\.swift|.*\+tvOS\.swift|TopShelf/.*\.swift)$")


class DriftError(Exception):
    pass


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "silo-tizen-parity-drift"})
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def cells(line):
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def parse_android_tv(markdown):
    """Map "Section / Feature" to the TV column's status for every table row."""
    rows, section, tv_column = {}, "", None
    for line in markdown.splitlines():
        if line.startswith("## "):
            section, tv_column = line[3:].strip(), None
        elif line.startswith("|"):
            row = cells(line)
            if row and row[0] == "Feature":
                tv_column = row.index("TV") if "TV" in row else None
            elif tv_column is not None and not set("".join(row)) <= set("-: "):
                if len(row) > tv_column:
                    rows[f"{section} / {row[0]}"] = row[tv_column]
    if not rows:
        raise DriftError("no Feature tables with a TV column found in silo-android FEATURES.md")
    return rows


def tvos_files(tree_json):
    tree = json.loads(tree_json)
    if tree.get("truncated"):
        raise DriftError("silo-apple's tree listing was truncated; tvOS files cannot be compared")
    files = sorted(entry["path"] for entry in tree["tree"]
                   if entry.get("type") == "blob" and TVOS_PATH.match(entry["path"]))
    if not files:
        raise DriftError("no tvOS source files found in silo-apple")
    return files


def current_state():
    return {"android_tv": parse_android_tv(fetch(ANDROID_FEATURES)), "apple_tvos_files": tvos_files(fetch(APPLE_TREE))}


def drift_report(old, new):
    """Markdown describing what changed upstream, or "" when nothing did."""
    sections = []
    old_rows, new_rows = old.get("android_tv", {}), new["android_tv"]
    added = sorted(set(new_rows) - set(old_rows))
    removed = sorted(set(old_rows) - set(new_rows))
    changed = sorted(key for key in set(old_rows) & set(new_rows) if old_rows[key] != new_rows[key])
    if added or removed or changed:
        lines = ["## Android TV ([silo-android `FEATURES.md`](https://github.com/Silo-Server/silo-android/blob/main/FEATURES.md))", ""]
        lines += [f"- Added: {key} ({new_rows[key]})" for key in added]
        lines += [f"- Removed: {key}" for key in removed]
        lines += [f"- Changed: {key} ({old_rows[key]} → {new_rows[key]})" for key in changed]
        sections.append("\n".join(lines))
    old_files, new_files = set(old.get("apple_tvos_files", [])), set(new["apple_tvos_files"])
    if old_files != new_files:
        lines = ["## Apple TV ([silo-apple](https://github.com/Silo-Server/silo-apple) tvOS source files)", ""]
        lines += [f"- Added: `{path}`" for path in sorted(new_files - old_files)]
        lines += [f"- Removed: `{path}`" for path in sorted(old_files - new_files)]
        sections.append("\n".join(lines))
    if not sections:
        return ""
    return "\n\n".join([
        "Upstream changed since FEATURES.md was last reviewed.",
        "Update the affected FEATURES.md rows, then run `python3 scripts/parity-drift.py update` in the same pull request.",
        *sections,
    ]) + "\n"


def main(argv):
    parser = argparse.ArgumentParser(description="Report upstream feature changes that FEATURES.md has not caught up with.")
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("check")
    check.add_argument("--report", type=Path)
    commands.add_parser("update")
    args = parser.parse_args(argv)
    try:
        state = current_state()
    except (DriftError, OSError, ValueError, KeyError) as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1
    if args.command == "update":
        SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        SNAPSHOT.write_text(json.dumps(state, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
        print(f"recorded {len(state['android_tv'])} Android TV rows and {len(state['apple_tvos_files'])} tvOS files")
        return 0
    old = json.loads(SNAPSHOT.read_text(encoding="utf-8")) if SNAPSHOT.exists() else {}
    report = drift_report(old, state)
    if args.report:
        args.report.write_text(report, encoding="utf-8")
    else:
        print(report or "no drift")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
