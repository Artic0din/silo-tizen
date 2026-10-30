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
No Settings UI or settings writes are added.

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
Native fake-server tests and synthetic desktop captures do not prove real server playback, Chromium 76 rendering, Tizen software emulator behaviour or Samsung TV playback.
This slice does not implement visible transport controls, absolute seeking, trickplay, chapters, next-up or the broader recovery work.
