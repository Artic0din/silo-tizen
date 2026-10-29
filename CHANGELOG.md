# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Added strict TypeScript checks and a bundled build targeting Chrome 76.

### Changed

- Set the minimum app platform to Tizen 6.0.

### Security

- Updated the Playwright development dependency from 1.49.0 to 1.64.1 to include the fix for [GHSA-7mvr-c777-76hp](https://github.com/advisories/GHSA-7mvr-c777-76hp), where Playwright's macOS Chrome and Edge install scripts did not verify TLS certificates.
  Playwright runs only the desktop browser checks and is not part of the packaged TV app.
