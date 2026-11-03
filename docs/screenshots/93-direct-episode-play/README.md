# Direct episode playback evidence

These captures verify the bounded behavior change in [#93](https://github.com/Artic0din/silo-tizen/issues/93).
They do not establish whole-Details visual parity or decoded playback.

## Runtime and identity

- Current source: `22dc1f489ce1270497450bfd28d1deccdc43ea70`.
- Current signed WGT SHA-256: `2c79ee6285142b0ff32a9a2fc7f120c12d274ede8693690fc13246ebb0b1bb11`.
- Before source: `602adac960eff4235420d93f8fb80631fd4f1022`, the earlier signed Details baseline.
- Before WGT SHA-256: `b1bd6e089fb0d5be7ac2292221952d23d11f5a8a9853d8f3bbd11b6c2f4494fd`.
- Samsung TV Web Simulator 10.0.6, NW.js Chromium `137.0.7151.69`, logical app viewport 1920×1080, DPR 2.
- Captured on 4 November 2026 in Australia/Melbourne, using the same account, series, season and third episode for the before/current comparison.

All 15 installed files matched their respective signed archive before each version ran.
Loaded JavaScript matched the current package at `a1fd46f08dd98ff09b896640bb7d87d3811e459d39b9736b460877a6aea5a1ad` and the baseline at `ac3db5aed0238fbce43c6124f953d34c472aa45cf4c52a4e086eedb6169a7f45`.
The baseline and current CSS bytes are identical at `ca57f2768d2a289c664b69cb30b9a6729dd4e8556ff39bec82c87a57f8fabd5a`.
Archive hashes are recorded in [installed-assets.json](installed-assets.json); capture hashes and observations are in [evidence.json](evidence.json).

The workstation remained locked.
A persistent SDK debugging connection with focus emulation kept the actual app foregrounded; closing a connection immediately resets its emulated focus.
The native window adapter was unavailable, so captures use the SDK's rendered app frame rather than a desktop screenshot.
No application visibility getter, authentication response, player implementation or server answer was replaced.

## Before and current

| State | Before | Current |
| --- | --- | --- |
| Series, Season 1, third episode focused | [Next episode label](before-series.png) | [Numbered primary action and retained rail](after-return.png) |
| Short Select on that episode | [Intermediate episode Details](before-select.png) | [Direct player handoff](after-player.png) |
| Explicit information access | Default destination above | [Held Select menu](episode-actions.png), then [Episode information](episode-information.png) |

The baseline short Select opened episode Details with zero playback starts.
On the current package, remote Down/Right movement selected the third episode, and short Select entered the existing preparation route, then received HTTP 201 from playback start.
The series visit remained retained behind the player; the observed transition did not visit episode Details.
The initial subtitle preference/replan path completed, with a successful replan response.
One watch resource exposed status 0 in resource timing, so these observations do not independently certify every resume-read status or fallback branch.
Fresh-progress replacement, saved Auto subtitle choices, Start Over, cancellation and failure cases have separate automated RED/GREEN coverage.

Remote Back removed the player and restored the same third episode and season.
Held Select opened Card actions, including Episode information, without another playback start.
That explicit destination retained Version, Audio and Subtitles controls and the existing synopsis path.

The primary action displayed `Play S2:E1` for the server's actual next target.
Pointer activation reached that episode's player, with one HTTP 201 start and no intermediate episode page; remote Back restored `next-episode` focus.
The SDK keyboard attempt on this ordinary button produced no activation, so native primary-action keyboard behavior is not certified by this capture.
Desktop remote tests and the signed rail Select journey are separate evidence; no product cause was established for the SDK keyboard attempt.

## Recording

[Primary Play and return](primary-play-return.mp4) records pointer activation of `Play S2:E1`, preparation, the loading player and remote Back to the primary action.
It contains one 1920×1080 H.264 video stream, no audio, 13 frames over 40.12 seconds.
SDK compositor frames retain their observed timing and are cropped to the app frame without scaling.
The earlier no-activation keyboard recording and incomplete rail recording are excluded from publication.

The player remained on Loading with no decoded picture observed.
Successful decoding, audible output and physical-TV AVPlay acceptance are not claimed.
The public images and every published video frame were inspected for incidental account, server, login-code, credential and desktop disclosures.
They show public title artwork and metadata plus anonymous watched/next-episode UI state.
No account identity, server/address, login code, credential, sign-in or desktop capture is included.

## Comparison limits

The pinned Apple contract at `1a7cceeaf3b2bfc4f889c00487d19b2c6f843940` binds rail Select and Play to direct episode playback and uses numbered Play/Resume primary actions.
See [TVSeriesDetailView](https://github.com/Silo-Server/silo-apple/blob/1a7cceeaf3b2bfc4f889c00487d19b2c6f843940/iosApp/iosApp/tvOS/Screens/Detail/TVSeriesDetailView.swift#L499-L559) and [rail bindings](https://github.com/Silo-Server/silo-apple/blob/1a7cceeaf3b2bfc4f889c00487d19b2c6f843940/iosApp/iosApp/tvOS/Screens/Detail/TVSeriesDetailView.swift#L823-L845).
A current same-state Apple screenshot is missing: Xcode lists the Apple TV simulator, but the required device tool does not expose that tvOS device even after Xcode restart.
This is a tooling/evidence limit, not a proven Tizen platform limitation or an Apple pixel-parity PASS.

The series comparison shows a small vertical-placement difference despite identical CSS; its cause was not established and no layout correction belongs to this behavior slice.
Broader layout acceptance remains under [#92](https://github.com/Artic0din/silo-tizen/issues/92) and [#97](https://github.com/Artic0din/silo-tizen/issues/97).
The pre-existing related-title failure was also visible; diagnosis remains under [#90](https://github.com/Artic0din/silo-tizen/issues/90).
No physical TV was used, and the SDK's disabled web security does not establish packaged-origin CORS acceptance.
