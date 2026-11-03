# Releasing

Releases run from GitHub Actions on `main`.
Each run picks its own version and build number from the repository's tags.

## Tester build

Actions → **Release** → Run workflow, leaving `bump` on `build`.

The run tags the commit `v1.0.0-beta.23`, writes `1.0.0` into `app/config.xml`, and signs the package with the maintainer's Samsung certificate.
It publishes `silo-tizen-1.0.0-23.wgt` and its `.sha256` on a GitHub prerelease.
Its notes list the pull requests merged since the previous build, grouped by label (`.github/release.yml`).

It requires **Tizen Builds** to have passed on the commit, so run it once `main` is green.

The very first run has no tester build to continue from: enter the version to start with, such as `0.1.0`, as `version`.

If a run fails, use **Re-run failed jobs**: it keeps the same tag and build number.
Delete the tag instead only if that run never published its prerelease.
The next run refuses to start while the newest tag has no release, so its notes don't skip changes no tester got.

## Installing a tester build

The signing certificate lists the TVs it may install on (their DUIDs), so a tester build installs only on those TVs.
On a listed TV in Developer Mode, install the `.wgt` with Tizen Studio's Device Manager or `tizen install -n silo-tizen-1.0.0-23.wgt -t <device>`.
Check the file against its `.sha256` first.

## Store release

Samsung TV Seller Office has no upload API, so a store release is part workflow, part manual.

1. Actions → **Promote** → enter the tester build to release, such as `v1.0.0-beta.23`.
   Nothing is rebuilt: GitHub gets a draft release `v1.0.0` on the same commit with the same `.wgt` and checksum.
   The run's summary lists the next steps and the store notes (Features and Fixes, at most 500 characters).
2. In [TV Seller Office](https://seller.samsungapps.com/tv/), **Applications > App Package > Upload** the `.wgt` from the draft.
   Seller Office pre-tests it and refuses a version it has already received.
3. Add the store notes and submit the version for certification.
4. On GitHub → Releases, edit the `v1.0.0` draft notes if needed.
5. When Samsung approves, publish the GitHub release.
   `published.yml` then copies its `.wgt` to `silo-tizen-latest.wgt`, so `releases/latest/download/silo-tizen-latest.wgt` serves this version.

While the draft exists, version 1.0.0 counts as released: Release refuses `bump: build`, and `bump: minor` starts 1.1.0.
If Samsung rejects the build, delete the GitHub draft and fix the problem.
Then run Release with `version: 1.0.0`, because once 1.1.0 has started, `bump: build` continues that one.
Promote the new build.

## After a store release

The next Release run needs `bump: minor` (the next version has new features) or `bump: patch` (fixes only).
`bump: build` refuses a version that's already released.

## Numbers

- `1.0.0` is the version people see, and the widget version in `config.xml`.
  It stays the same for every tester build until that version is released on the Samsung TV store.
  Tizen limits it to `[0-255].[0-255].[0-65535]`, and Seller Office refuses a version it has already received.
- `23` is the build number: one counter for the whole repository that never resets.
- Tags: `vX.Y.Z-beta.B` for tester builds (GitHub prereleases) and `vX.Y.Z` for store releases.

## Latest tester build link

`releases/download/beta-latest/silo-tizen-latest-beta.wgt` always serves the newest tester build.
Every Release run moves the `beta-latest` tag to its commit and replaces that file on the "Latest tester build" prerelease, unless a newer tester build already exists.
