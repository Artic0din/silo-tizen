# Settings rows

Apple source is [silo-apple `2ef3a171`](https://github.com/Silo-Server/silo-apple/tree/2ef3a171dfa597a450886b2de3745acfd5132b3d), tvOS only. `SettingsView` on tvOS is `TVSettingsView`. The installed Apple build was not read.

Playback already sends `playback.preferred_quality` and `playback.max_bitrate_kbps` on each start. The Quality section shows those two rows, then Apple's footer for the effective pair:

- Auto, or a stored `original`: `Plays the original file whenever your device and connection can handle it.`
- Any other resolution, using Apple's label (`4K` for 2160p): `Plays the original file up to {label}. Larger files are converted.`
- A positive bitrate cap adds `Files above this bitrate are converted to fit.`

Maximum Bitrate uses Apple's spelling: `No limit`, whole Mbps above 1000 kbps (`6 Mbps`), one decimal when the cap is not whole Mbps (`1.5 Mbps`, `2.0 Mbps` for 1999 kbps), and `{n} kbps` below 1000. A stored cap that is not in the preset list stays in descending order and selected, as `SiloQualityPresets.bitrateChoices(including:)` does. The picker has no separate kbps field or Save action.

## Rows left without a control

A row that nothing on this TV acts on stays hidden.

| Row | Reason |
| --- | --- |
| Paired Silo Profile | Open PR #292. This branch does not change it. |
| Play Theme Music, Loop Theme Music | No theme-song reader or title-page player. Issue #293. |
| Show Audiobooks | Open PR #230. No Audiobooks tab. |
| Show Next Up | Playback offers Play next only after the episode ends. Nothing reads `playback.next_up_prompt_seconds`. Open PR #213 owns the pre-end reader. |
| Audiobooks Skip Back, Skip Forward | Open PR #230. No audiobook player. |
| Lower quality when buffering, learned-limit Reset, Connection speed, Test speed | Playback reports buffering. It does not lower quality, store a learned limit, or measure connection speed. Issue #293. |
| Use Device Settings | tvOS reads Media Accessibility caption preferences (`SystemCaptionAppearance.swift`). Samsung captions are the app overlay. No TV caption-style API is available, so the switch would not change language, behavior, or appearance. |
| Watch Party | Not built. Issue #54. |
| Diagnostics | Open issue #218, parked. |
