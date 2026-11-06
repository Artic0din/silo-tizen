# Player options

Issue #225 adds Info, Stats, Video, Audio, Subtitles and Chapters in Apple TV order.
Info, Stats and Video remain available throughout active playback.
Audio and Chapters hide when their lists are empty; Subtitles remains available for tracks or actionable AI tools.
Chapter reads use the plan's effective media file, including after a version switch.
Selecting a chapter uses the existing source-time seek and dismisses options without changing pause state.
Failed chapter or title reads offer Retry in Info and never stop playback.

## Reference

Apple source: `Silo-Server/silo-apple` at `bbd1e470f0e1d3a99f486d0d7246d11ed1c97d55`.
`Screens/Player/tvOS/TVPlayerInfoHUD.swift` is entirely inside `#if os(tvOS)` (lines 1–2214).
Paths below are relative to `iosApp/iosApp`.

- `Screens/Player/tvOS/TVPlayerInfoHUD.swift:38–72`: tab order and availability.
- `Screens/Player/tvOS/TVPlayerInfoHUD.swift:599–730`: title, metadata, overview, stream rows and current chapter.
- `Screens/Player/tvOS/TVPlayerInfoHUD.swift:733–777`: separate Stats pane.
- `Screens/Player/PlaybackStatsPanel.swift:68–80`: Source/Media and Buffer/Network/Engine columns.
- `Screens/Player/tvOS/TVPlayerInfoHUD.swift:831–901`: speed, aspect and Auto-play next controls.
- `Screens/Player/tvOS/TVPlayerInfoHUD.swift:961`: speeds 0.75, 1.0, 1.25, 1.5 and 2.0.
- `Screens/Player/PlayerSettings.swift:19–36`: Fit, Fill and Stretch.
- `Screens/Player/tvOS/TVPlayerInfoHUD.swift:2053–2162`: numbered chapter rows, title fallback, time, current marker, seek and dismiss.
The tvOS chapter rows have no thumbnails.

Server source: `Silo-Server/silo-server` at `4e3020a266fca972d61fd82f7438eacb3430ddd4`.
`contracts/api/v2/openapi.json` defines `WatchFileVersion.chapters` and `WatchChapter` with source-time start/end seconds.
`docs/architecture/trickplay.md` defines separate per-file JPEG sprite-sheet previews.
Existing scrub previews remain owned by `SeekThumbnails`; chapter rows do not fetch artwork on focus.

## Platform limits

[Samsung AVPlay API](https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avplay-api.html) documents `setSpeed(long playbackSpeed)`, with integer rates and protocol-dependent support.
The Apple intersection is 1× and 2×; fractional rates are omitted.
Speed is exposed for `http_progressive` plans with `setSpeed`, and omitted for HLS or unspecified protocols without a verified rate contract.
Video speed and aspect apply to this playback attempt and are reapplied when its transport reopens or restores.
Auto-play next uses the existing profile preference and changes only after a successful save.

Fit maps to `PLAYER_DISPLAY_MODE_LETTER_BOX`; Stretch maps to `PLAYER_DISPLAY_MODE_FULL_SCREEN`.
Fill is omitted: Samsung describes `PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO` as following video DAR/PAR, which does not establish Apple's crop-to-fill behaviour.
Missing platform methods hide their controls; platform exceptions retain the last confirmed selection and show a message.
Subtitle controls belong to issue #226.

Stats display engine and playback-plan facts, including output codec, resolution and configured bitrate when supplied.
Configured bitrate is labelled explicitly and is never presented as measured throughput.
Buffer seconds/bytes, download speed, network throughput, FPS, dropped frames, decoder memory and engine-specific Apple metrics are omitted because this client does not measure them.
No estimate is substituted.

## Native capture checklist

Same-state comparison is pending; the PR must remain unmerged until it passes.
No simulator, TV, signed package or installed-build acceptance is claimed by desktop tests.

1. Build and identify the signed WGT for the PR head, install through the established device workflow, and verify the installed assets match it.
   Record the Apple installed build separately from the Apple source revision.
2. **Playback required:** open the same title, file, position and pause state on both clients.
   Capture Info and Stats at native dimensions, with identical focus and scroll, and compare metadata and the presence of unknown-value omissions.
3. **Playback required:** choose content with chapters, record remote navigation into Chapters, move to a later chapter, select it, and verify the resulting source position, HUD dismissal and preserved pause state.
   Repeat with no chapters and after changing edition, then capture chapter-read failure and Retry using a controlled test service.
4. **Playback required:** record HTTP 1×/2×, Fit/Stretch, remote focus across updates, unsupported-method/error states, and settings restoration after reconnect and visibility restore.
   Check HLS hides unverified speed controls and compare the documented Fill omission explicitly.
5. **Episode playback required:** toggle Auto-play next both ways, verify the saved profile value, and check pre-end/EOF continuation with each value.
   Capture save failure without changing the displayed value, plus the pending-write focus state.

Before publishing captures, remove private media details, addresses, credentials and device identifiers.
