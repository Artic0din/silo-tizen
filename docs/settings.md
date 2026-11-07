# Settings rows

Apple source is [silo-apple `2ef3a171`](https://github.com/Silo-Server/silo-apple/tree/2ef3a171dfa597a450886b2de3745acfd5132b3d), tvOS only. `SettingsView` on tvOS is `TVSettingsView`. The installed Apple build was not read.

Playback already sends `playback.preferred_quality` and `playback.max_bitrate_kbps` on each start. The Quality section shows those two rows, then Apple's footer for the effective pair:

- Auto, or a stored `original`: `Plays the original file whenever your device and connection can handle it.`
- Any other resolution, using Apple's label (`4K` for 2160p): `Plays the original file up to {label}. Larger files are converted.`
- A positive bitrate cap adds `Files above this bitrate are converted to fit.`

Maximum Bitrate uses Apple's spelling: `No limit`, whole Mbps above 1000 kbps (`6 Mbps`), one decimal when the cap is not whole Mbps (`1.5 Mbps`, `2.0 Mbps` for 1999 kbps), and `{n} kbps` below 1000. A stored cap that is not in the preset list stays in descending order and selected, as `SiloQualityPresets.bitrateChoices(including:)` does. The picker has no separate kbps field or Save action.

## HDR and Dolby Vision

`TVPlaybackSettingsView.swift:176-202` puts two switches in STREAMING, after Audio Language and before Seek Cache: **HDR**, then **Dolby Vision**. Each click writes the opposite boolean (`viewModel.hdrEnabled = !current`, then the same for Dolby Vision). The keys are `player.hdr_enabled` and `player.dolby_vision_enabled` (`SettingKeys.generated.swift:97` and `:93`). Both are remote booleans, default true, allowed only at `profile_device` (`PlayerSettings.swift:740-741`, `setHDREnabled` / `setDolbyVisionEnabled` at `1092-1099`). The vendored settings subset does not list them. A live contract that matches that device-only definition shows the rows. Any other shape hides the row, the same way the other optional rows stay hidden. The platform list may omit `tizen`; these keys are not a profile-scope adoption.

Dolby Vision reads Off and is not focusable while HDR is off (`TVPlaybackSettingsView.swift:200-202`, `SettingsViewModel.swift:146-150`). The stored Dolby Vision choice is kept. Turning HDR back on shows that stored choice again.

The footer under the rows is the first sentence of `SettingsViewModel.hdrFooterText` (`SettingsViewModel.swift:136-142`): "With HDR off, videos the server converts for this device are sent in SDR, without Dolby Vision." Apple's tvOS sentence after that says original files can still play in HDR and the TV can still switch for them. This client does not send that sentence. AVPlay has no separate path that keeps an original file in HDR after the setting is off, and this client does not claim `client_managed_dynamic_range`. Off clears every HDR claim, including originals.

The panel probe is Samsung's `webapis.avinfo.isHdrTvSupport()` (AvInfo API, since Tizen 2.3). The method returns a boolean and lists no privilege, so `config.xml` gains none. `webapis.productinfo` has no HDR or Dolby Vision call; the productinfo privilege already present is only for the model name. A missing object, a non-boolean, or a throw is SDR. The boolean does not name HDR10, HLG, or Dolby Vision, so a true result reports HDR10 only. HLG and Dolby Vision stay false. `hdr10_plus` stays false (`ApplePlaybackV3Capabilities.swift:479-480`).

The capability body follows `ApplePlaybackV3Capabilities.swift:439-483` and `PlaybackProtocolV3Models.swift:168-169`:

- HDR10 is claimed only when the HDR setting is on and the panel reported HDR10.
- HLG is claimed only when the HDR setting is on and the panel reported HLG. This probe never reports it.
- Dolby Vision profiles `[5, 8]` are sent only when HDR is on, Dolby Vision is on, and the panel reported Dolby Vision. This probe never reports it, so a saved On does not put profiles on the wire.
- `capabilities.hdr` is true only when one of those claims is present. The same `hdr_details` go on `client_capabilities`, `output`, and both `original_http` and `hls`.

Off, an unsupported panel, a throwing probe, or a failed read of a key the server offered sends the same SDR profile as before: `hdr: false` and no `hdr_details`. A title is never declared direct-playable in a range the panel did not report. If the server does not offer the keys, the Apple default stays on, so a panel that reports HDR still claims HDR10. Resolution stays 1080p. No DTS and no audio passthrough.

No TV, simulator, or live server has shown an HDR picture. A person has to check that on the S95C.

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
