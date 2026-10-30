# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Added strict TypeScript checks and a bundled build targeting Chrome 76.
- Added a native Silo `/api/v2` session core with device-code sign-in, household profiles and PIN checks, and credential storage in Tizen KeyManager. No screen uses it yet.
- Added native sign-in screens for server address entry and device-code sign-in with a QR code, remote-key focus and recovery for each failure. The app does not show them yet.
- Added native household profile screens for choosing and switching profiles, PIN entry with lockout handling, and sign-out. The app does not show them yet.
- Added a native player that plays one file through the server's playback plan with AVPlay, with resume, pause, seeking, progress reporting and a final stop, and recovers from a failed route by asking the server for another one. The app does not show it yet, and media playback on a TV is not yet proven.
- Added a CI workflow that runs the type checks, the build and all tests.

### Changed

- Set the minimum app platform to Tizen 6.0.

### Fixed

- Prevented an old stream from ending playback while a backward seek waited for a replacement plan in the staged native player.
- Stopped the staged native player when Silo was backgrounded and preserved codec failures received during a seek.
- Kept playback teardown safe during pending seeks, preserved pause after server re-anchoring, and honored server retry delays in the staged native player.
- Preserved remote focus when a PIN check finished unsuccessfully.
- Kept focus during native profile sign-out and waited for credential cleanup before returning to sign-in.
- Kept manual device-code sign-in available when its link could not be encoded as a QR code.
- Replaced an indefinite connection wait with a retry message while earlier sign-in storage cleanup remained pending.

### Security

- Rejected insecure native media URLs and canceled native requests and media-token reads when their account or profile authority changed.
- Revoked native sign-ins abandoned before the sign-in screens handed the account to the app.
- Revoked native refresh credentials received after logout or another sign-in replaced their session.
- Updated the Playwright development dependency from 1.49.0 to 1.64.1 to include the fix for [GHSA-7mvr-c777-76hp](https://github.com/advisories/GHSA-7mvr-c777-76hp), where Playwright's macOS Chrome and Edge install scripts did not verify TLS certificates.
  Playwright runs only the desktop browser checks and is not part of the packaged TV app.
