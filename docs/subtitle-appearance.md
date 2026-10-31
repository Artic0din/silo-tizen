# Profile subtitles

Issue [#64](https://github.com/Artic0din/silo-tizen/issues/64) uses the native contract pinned by [SOURCE](../src/contracts/v2/SOURCE).
`getEffectiveSubtitleAppearance` reads `/settings/subtitle-appearance/effective` with the captured profile and stable device headers.
Its `effective_value` is a JSON string containing a sparse appearance override.
The client merges it over the complete manifest defaults, validates fonts, colors, opacity and enums, and uses a readable default if the preference cannot be read.
`player.subtitle_sync_ms` is read as an effective profile/device preference; positive values delay captions.
Font size, family, text color/opacity, background color/style/opacity, outline and vertical position apply to the app's text overlay.
Unavailable fonts fall back to the TV's sans-serif font; the client downloads no fonts.

AVPlay remains the primary video player.
The app renders server-issued text artifacts at source timestamps plus `timing_origin_seconds`, following the protocol v3 subtitle artifact schema.
The pinned server's `playback_v3_subtitle_route_test.go` confirms VTT for ordinary text tracks and ASS for ASS/SSA tracks.
VTT/SRT text and ASS dialogue are supported; ASS styles, drawings, animation, layout and font attachments are not preserved.
The client advertises sidecar text support while leaving native embedded text, bitmap rendering, ASS styling and font attachments disabled.
Bitmap and server-burned subtitles cannot be restyled by this overlay.

Samsung's [AVPlay API](https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avplay-api.html) offers subtitle callbacks and external synchronization but no general font/color/background styling API.
Its external subtitle path requires a local downloaded file.
This implementation uses the app overlay rather than promising native AVPlay styling or changing TV-wide accessibility settings.
Apple's `SubtitleAppearance.swift` at `1a7cceeaf3b2bfc4f889c00487d19b2c6f843940` and the pinned shared `subtitle-appearance.json` establish the stored vocabulary and sparse-default behavior.

Episode subtitle menus expose an explicit action to keep the current track choice or Off for the series.
`updateSubtitlePreference`, `PUT /subtitle-prefs/{series_id}`, stores the server's combined index, language, mode and available track signature, so later episodes can resolve the preference even when ordinals change.
Playback choices remain transient unless this action is selected.
Writes are never automatically repeated, and a failure leaves playback running with a visible message.

Text downloads use HTTPS, omit ambient credentials, reject redirects, have a 15-second timeout and a 4 MiB acceptance limit.
Authority changes, new plans and teardown cancel stale loads; loading/failure notices appear in the subtitles menu.
Caption text is assigned through `textContent`, never executable HTML.
Desktop/native tests establish rendering, timing, safe text, preference validation, failure behavior and series-write requests.
Actual Samsung font metrics, browser/video compositing, signed WGT and physical-TV behavior remain hardware acceptance gates.
