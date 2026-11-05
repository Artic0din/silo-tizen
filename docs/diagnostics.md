# Diagnostics

Settings > Diagnostics provides a bounded, memory-only capture on this TV.
Opening the pane reads `/api/v2/diagnostics/capabilities` through the active session.
It never creates a report or sends log data.

## Server dependency

Server source `e3af98b06af2ee0ced92da518bf372f4b9fd5df6`, `internal/diagnostics/contract/contract.go:54`, accepts only `android`, `android-tv`, `ios`, `tvos`, and `roku`.
It rejects `tizen`.
Issue #138 tracks that dependency; availability alone does not establish platform support.
Send Diagnostics Now, destination selection and crash consent therefore remain unavailable.
No report bundle, upload transport, persistent consent, crash/hang collector or sent-reference persistence is implemented yet.
Issue #137 is not end-to-end accepted until these paths and native comparison pass.
Do not change the platform label to bypass validation.

## Apple TV reference

Read-only source: `Silo-Server/silo-apple` commit `bbd1e470f0e1d3a99f486d0d7246d11ed1c97d55`.
Paths below are relative to `iosApp/iosApp/`.

- `Screens/Settings/DiagnosticsSettingsView.swift:1` is iOS-only.
- `tvOS/Screens/Settings/TVDiagnosticsSettingsPane.swift:14` begins FEATURE STATE; CAPTURE includes Send Reports To, Debug Logging and Crash Reports.
- The same pane shows `Reports: None` for empty pending and sent history; sent entries show the reference as text, without a Copy ID action.
- `tvOS/Screens/Settings/TVDiagnosticsDestinationScreen.swift` defaults focus to the selected destination and offers Silo Diagnostics, My Silo Server and Cancel.
- `tvOS/Screens/Settings/TVDiagnosticsConsentScreen.swift` defaults focus to Cancel; Ask, Always (self-hosted only), Never and the confirmation Turn Off and Delete are the reference for the blocked consent work.
- `Shared/Diagnostics/Logging/LogRing.swift` bounds the Apple buffer at 4,000 lines and clears it when the binding changes.
- `Shared/Diagnostics/Logging/DiagLog.swift:369` redacts credentials, URLs, email, known hosts and file/media identities before retention.

This candidate adds Start/Stop Diagnostic Capture as requested by #137; that control is not present in the referenced tvOS pane.
Debug Logging is session-only in this candidate, unlike Apple's persisted device preference.
The same-state Apple/Samsung comparison is pending; this PR must remain unmerged until it passes.

## Privacy boundary

The session records only fixed method/outcome vocabulary, never request URLs, response bodies, headers, account/profile IDs or exception messages.
Capture also records the actual runtime model and Tizen user-agent version where available, plus the existing declared playback capability profile.
Missing runtime facts remain null.
No hardware measurements are inferred from the profile.
Logs are bounded at 4,000 lines of 2,048 characters and cleared on authority changes or Delete Local Capture.
There is no disk storage or automatic upload.

The last-mile redactor removes explicit sensitive values, HTTP/WebSocket URLs, authorization/cookie headers, bearer/JWT values, credential and identity key/value pairs, email addresses and common local filesystem paths.
Raw media names and arbitrary third-party exception text are excluded by the fixed-vocabulary logger rather than retained for regex filtering.
Planted-secret tests prove redaction of the retained evidence; there is no upload body to test until #138 is resolved.

## Native capture without sending

1. Install the candidate signed WGT through the normal release workflow; record its hash, commit, actual TV model, Tizen version and capture dimensions.
2. Open the profile menu, select Settings, then move Down to Diagnostics.
3. Press Right to enter the pane; move Down to Start Diagnostic Capture and press Enter.
4. Press Back to return to the Diagnostics category, then Back to leave Settings; reproduce the problem.
5. Return through Settings > Diagnostics and select Stop Diagnostic Capture.
6. Capture the screen and remote navigation recording, with private account/server details excluded.
7. Select Delete Local Capture when finished.

Do not select Send Diagnostics Now during capture acceptance.
This candidate has no report transport, so even that disabled control cannot send a report.
Use a fake server for upload-failure and populated-history acceptance once the Tizen contract is available.
No simulators, televisions or real diagnostics services were used during implementation.
