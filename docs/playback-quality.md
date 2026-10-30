# In-player quality

The existing audio/subtitle menu includes Quality only when the current server plan offers an alternative.
Auto is followed by server entries in server order, preferring `display_name` and sending the exact `label` as `quality_preference`.
Legacy Original entries are excluded.
The menu uses the current plan rather than a hardcoded resolution or bitrate ladder.

Before every start, the player reads effective `playback.preferred_quality` and `playback.max_bitrate_kbps` with the captured profile and stable device headers.
Missing settings use the contract defaults Auto and no cap; a failed or malformed settings read fails startup visibly.
Legacy saved Original maps to Auto.
These defaults are captured for the attempt, and an in-player choice is session-only.
Successful quality changes replace its requested preference and current cap; track changes, seeking and route recovery repeat both.
Fixed choices use the server rung's positive `bitrate_kbps`, and source-preserving rungs omit the cap.
Auto restores the saved bandwidth cap captured at startup.
Playback Settings edits the saved profile defaults through the existing Settings owner described below.

Auto remains selected when the session requests Auto, regardless of the delivered rung.
For a fixed preference, `plan_active_quality_v1` makes only a returned, offered `active_quality` authoritative.
With that feature and no active quality, nothing is highlighted.
Without it, only a matching explicit in-player pick is highlighted.
Resolution and bitrate are never used to guess delivery.

A quality change uses the existing serialized replan path with operation `quality_change`, source position, effective-file tracks, and unchanged opaque plan identities.
It clears route failure exclusions, keeps the playback attempt ID and gives the logical change one request ID, reused with an identical body on bounded retries.
Subtitle Off stays omitted and returned effective-file selections are adopted without remapping ordinals.
The latest local pause intent during the pending request is applied to replacement playback.
The existing physical seek barrier, progress reporting, background stop and authority cancellation still own transport lifetime.

Only a confirmed `adaptation_unavailable` keeps the predecessor transport and preference.
Uncertain exhausted responses, invalid successes and generic quality-replan 409 conflicts end the attempt.
A playable replacement retires the predecessor on the server; load failure recovers against the replacement identity or ends playback, never reopening the predecessor.

Contracts were checked against [server cc85149](https://github.com/Silo-Server/silo-server/tree/cc8514943289045e7b9f7ac8d36d4968bfe93926) and [canonical Apple quality rules](https://github.com/Silo-Server/silo-apple/blob/148d5d70f8b8ce982a827fead2b16f8de40f0f57/iosApp/iosApp/Screens/Player/ApplePlaybackQuality.swift).
The existing Skyline tokens and Chrome 76-compatible list layout are reused.

## Saved profile defaults

Profile menu → Settings → Playback offers Preferred audio, Preferred quality and Maximum bitrate.
General → Hidden libraries retains the same owner and readback behaviour.
Quality choices come from the supported server manifest, with its labels: Auto, 480p, 720p, 1080p and 2160p / 4K.
Deprecated Original and unfamiliar stored strings are displayed as current values, without becoming new choices or being rewritten during a read.
New profiles inherit Auto and no cap.

Maximum bitrate uses a native text field with numeric input mode and an explicit Save action.
Only whole integers from 100 to 200000 kbps are accepted; blank, zero, fractions and out-of-range values never send a write.
No limit writes JSON null; Use inherited default deletes only the profile row.
Cancel and remote Back discard the draft and return focus to the Maximum bitrate row.
The field starts from the explicit profile value, never a narrower effective device value.

Explicit profile defaults and the effective value/source on this TV remain separate.
A device override can still win after a confirmed profile write or reset and is never cleared here.
All writes use profile scope, the captured profile proof and stable device headers through the existing API/session owner.
Writes are never automatically resent; uncertain answers reconcile the explicit row and effective value before a user-triggered retry.
Profile authority changes discard late answers and remove the screen.
Unsupported capabilities, platforms, schema shapes or profile scopes do not expose these controls.

The pinned [Apple TV Settings](https://github.com/Silo-Server/silo-apple/blob/148d5d70f8b8ce982a827fead2b16f8de40f0f57/iosApp/iosApp/tvOS/Screens/Settings/TVPlaybackSettingsView.swift) separates resolution and bitrate into two pickers.
Its [quality presets](https://github.com/Silo-Server/silo-apple/blob/148d5d70f8b8ce982a827fead2b16f8de40f0f57/iosApp/iosApp/Networking/SiloQualityPresets.swift) offer discrete bitrate choices while retaining a stored custom cap.
This Tizen slice uses the requested numeric editor across the server's complete valid range, without adding a preset ladder or device-scope editor.
The binding [Skyline guide](https://github.com/Silo-Server/silo-apple/blob/148d5d70f8b8ce982a827fead2b16f8de40f0f57/docs/skyline-design-guide.md) has SHA-256 `2d42d292e01ab6ee539278b63c286756fc432edf876a9286a33c9e853672cac2`.
The selected fixture definitions remain an exact subset of the pinned public manifest; provenance is recorded in the contract README.

Native tests write and read back Settings, then start the real PlaybackController repeatedly and assert exact quality and bandwidth request fields.
The existing player consumer reads these defaults before every start; this slice changes no player production code.
Native fake-server tests and synthetic desktop captures do not prove real server playback, Chromium 76 rendering, Tizen software emulator behaviour or Samsung TV playback.
Device override editing, automatic subtitle resolution, trickplay and playback-planner redesign remain outside this slice.
Issue 29 and whole-app acceptance remain incomplete.
