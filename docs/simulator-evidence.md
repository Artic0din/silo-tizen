# Samsung simulator evidence

The Samsung TV Web Simulator can exercise the packaged Silo screens and remote navigation against a real server.
It is an NW.js desktop application, not the Tizen software emulator or a physical TV.
Samsung's [TV Simulator guide](https://developer.samsung.com/smarttv/develop/tools/additional-tools/vscode/tv-simulator.html) covers loading a WGT; the macOS command below records the inspected SDK installation.
Serialize simulator work on the Mac that also runs Xcode; coordinate ownership before replacing an installed app or changing screens.

## Build the candidate

Use the branch being reviewed, with Node and browser dependencies installed as described in the [README](../README.md#build-and-package).
Keep the developer security profile and certificates outside the repository.

```bash
npm ci
export TIZEN_SECURITY_PROFILE="YourProfileName"
./scripts/build-wgt.sh
shasum -a 256 dist/Silo.wgt
```

Record the source commit, uncommitted-diff identity if applicable, package hash and simulator version.
The package command stages the web app and signs `dist/Silo.wgt`; do not substitute `tizen build-web` on CLI 6.1.
Keep a copy of any installed candidate that must be restored.

## Launch on macOS

The installed SDK's `tools/sec-tv-simulator/readme.txt` documents the remote-debugging options.
Run from the simulator directory so its relative resources resolve.
Use a fresh, private profile for a separate test session; it will not inherit the previous session's sign-in state.
Do not start this command while another agent or person owns the simulator.

```bash
simulator_dir="${TIZEN_STUDIO_HOME:-$HOME/tizen-sdk}/tools/sec-tv-simulator"
simulator_profile="$(mktemp -d "${TMPDIR:-/tmp}/silo-tv-simulator.XXXXXX")"
cd "$simulator_dir"
./nwjs.app/Contents/MacOS/nwjs \
  --user-data-dir="$simulator_profile" \
  --remote-debugging-port=9333 \
  --disableInspector
```

Use the simulator's app-loading interface to install the signed `Silo.wgt`, then launch its Silo tile.
If the simulator reports an install or launch error, verify the loaded files before claiming that the new candidate is running.
A shell reload and launching the tile can recover the observed `Cannot read properties of null (reading 'location')` launch failure; repeated failure is a blocker, not a successful install.
Remote debugging is for local inspection; close its clients when finished and do not expose its port to the network.

## Transport and playback limits

The current app uses native `/api/v2`; the Jellyfin-compatible implementation is retired.
At the audited baseline, server entry accepts HTTPS with normal certificate validation.
Use a valid HTTPS route for that baseline rather than changing the app or disabling certificate checks for a test.
Later transport changes must be tested as their own candidate.

The SDK inspected during the parity audit was Samsung simulator 10.0.6 with an NW.js Chromium 137 runtime.
Its bundled `nwjs.app/Contents/Resources/app.nw/package.json` declares `--disable-web-security`.
That is a simulator property, not an application fix: a 200 response there does not prove browser CORS headers, preflights or physical-TV origin policy.
Do not infer the engine version from the simulator's TV user-agent string.
Check server responses and the actual target runtime separately.
Do not add certificate bypasses or rewrite server responses to manufacture acceptance.

The package declares its content policy in `app/config.xml`.
It preserves app-only scripts and styles, allows generated `data:` images for the Swift-derived grain tile, and permits app-origin objects for Samsung's required AVPlay surface.
The [AVPlay guide](https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-avplay.html) requires that native object; removing it is not a policy fix.
The policy regression test enforces the packaged directives in Chromium, checks the real grain image, and rejects a foreign object.
The simulator's disabled web security cannot prove physical-TV policy enforcement or AVPlay rendering.
Full physical-TV validation is deferred until simulator parity is complete.
The policy correction includes a [historical Apple/current Samsung grain comparison](screenshots/113-policy/grain-comparison.png) and the [paired package/installed asset hashes](screenshots/113-policy/installed-sha256.txt).
The comparison labels its different drift phases, signed-out state and platform substitutions; it is not complete visual acceptance.

The simulator's AVPlay support did not provide successful playback in the audited runs.
An unavailable player or failed open is failure-path evidence only.
Use synthetic AVPlay only in the existing automated harness; never install a stand-in into the package and label its output native playback proof.
Decoded video, audio, successful playback return and physical-remote behavior need a capable emulator or real TV.

## Capture the running app

1. Verify the installed app's JavaScript, CSS and other changed assets match the signed WGT bytes.
   Record hashes for both sides; the package hash alone does not identify the running app.
2. Reproduce the before and after state with the same server, profile, title and settings.
   Record remote keys, loading/error behavior, request paths and statuses without credentials or private hosts.
3. Capture the actual app viewport, not the desktop or simulator shell.
   Record the native dimensions and wait for transitions to settle; confirm with a second frame when necessary.
4. For a user-facing PR, capture the matching state in the real Apple TV app and label both sources and their source/build identities.
   Synthetic browser renders are supplementary and cannot replace this pair.
5. Preserve raw captures privately and publish only checked, redacted copies.
   Keep private directories mode 700 and private files mode 600; omit sign-in codes, server addresses, account names and credentials.

The audited Samsung app viewport was 1920×1080.
Xcode supplied Apple TV previews at 960×540 for a 1920×1080 logical screen.
A side-by-side canvas may show Samsung at 50% and Apple at 100%, but must label those scales and must not call an upscaled preview a native-resolution capture.
Mask private information consistently without hiding the UI change being reviewed.
Report remaining layout or behavior differences; attaching a comparison does not establish that the result matches.

Use the TV Back key code 10009 for single-Back evidence.
The Mac Esc key produced a second Back in the simulator and is not equivalent for focus-restoration tests.
If a locked Mac leaves the simulator page hidden, disclose any CDP focus emulation used by the harness; it does not establish real hide/return behavior.
Keep any test mutation scoped, record it and restore the original state, including an originally unset value.
Close the Xcode session and debugging clients you opened, and explicitly release simulator ownership.

## PR acceptance

Record each proof separately: automated tests, signed WGT, simulator, Apple TV comparison and real TV.
For a product UI change, the affected result must match the Apple TV app; unresolved differences remain failed or unverified gates.
A documentation-only PR should say that it changes no app behavior and should not claim new product acceptance.
See the [PR template](../.github/pull_request_template.md) for the evidence checklist.
