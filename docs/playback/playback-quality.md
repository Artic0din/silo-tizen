# In-player quality

## Settings follow-up after the 6 November comparison

The implementation reference for this follow-up is Apple `7baff3ef657757cc0a69202e86dd4bd5c7fcb585`, restricted to tvOS code.
A signed re-check at Tizen `63821ba` on 6 November passed focus, Back, scroll, pickers, QR, Accounts, pinned rail, scroll reset and stable modal background, as reported in the implementation brief.
It also confirmed VIDEO skip rows after scrolling farther down.
These later corrections need a new signed comparison.
The installed Apple app wins where the source differs.

| Source under `tvOS/Screens/Settings/` | Exact reference |
| --- | --- |
| `TVSettingsView.swift:141-144,179-225,242-282,444-465` | Rail width 490, pane gap 52, rail spacing 6, title 48, category title 25/detail 16, rail glyph 22 inside width 34, profile avatar 68 with gap 18, version top inset 10, Sign Out font 27, header tile 72 with icon 34 and gap 20 |
| `TVSettingsComponents.swift:248-249` | Pane row padding 24 horizontal and 17 vertical; measured installed rows are 66 high with pitch 74, rail rows 82 high with pitch 88 |
| `TVGeneralSettingsView.swift:24-44,72-102,153-176,183-217` | Paired Profile, launch footer, Cards & Posters, title-art footer, theme music and loop |
| `TVSubtitleSettingsView.swift:18-20,85-102,105-145,183-193` | Metadata is conditionally under Subtitles; appearance starts with preview and device scope; Outline Color is “—” when outline is off |
| `TVSettingsComponents.swift:589-630,700-719` | Privacy QR size 320 with padding 22 and gap 54, Done in the text column; picker subtitle and Menu hint |
| `TVSettingsView.swift:437-439` | Category changes recreate the pane at the top |

Paired Profile stays out because it binds an Apple TV OS user; Samsung has no matching identity owner.
Theme music and loop stay out because this client has no title-page audio playback owner.
Use Device Settings stays out because tvOS follows Accessibility caption preferences, with no established Samsung bridge.
Connection speed is shown and tested from Playback settings. Playback start still does not send a bandwidth estimate. HDR, audio passthrough and buffer controls remain out without Samsung consumers.
Watch Party stays behind #54, Diagnostics behind #218, and spoiler controls remain with #212.
Show Next Up follows Auto-Play Next Episode in EPISODES and edits the timing consumed by the before-end player prompt.
Its five choices and Use Profile Setting inheritance follow tvOS source `7baff3ef657757cc0a69202e86dd4bd5c7fcb585`, `TVPlaybackSettingsView.swift:264-288,502-508` and `TVSettingsComponents.swift:72-78`.
No upstream repository needs a write for these changes.

Hidden Libraries no longer opens an editor.
If a stored effective list is nonempty, Server offers Restore All Libraries, which writes an empty profile list through the existing confirmed Settings writer and refreshes the catalog on exit.
The list has no local duplicate to clear.
The recovery action disappears after confirmation; failures keep it available with the existing reload/retry path.
Accounts covers server management, so the duplicate Manage Servers row is hidden when Accounts is available.

Re-check on the other Mac: all four rail selections, profile/version placement, General top/bottom and descriptions, Playback groups and every picker, Subtitles with metadata AI enabled/disabled and profile/device appearance, outline off/on, Reset cancel/confirm, Server Accounts return and legacy library recovery, Privacy Done/Back, long-pane scrolling, category reset, and modal open/close without background movement.
Use the same data, focus, viewport and scroll state at native 1920×1080; record remote movement and identify the newly signed package and installed assets.
No simulator, TV, signed package, live server or native comparison ran for this follow-up.

## Settings reference and remaining parity gates (#104)

Reference: `Silo-Server/silo-apple` at `7baff3ef657757cc0a69202e86dd4bd5c7fcb585`.
These are source observations, not verification of an installed Apple build.
All Apple paths below are relative to `iosApp/iosApp/`.
Tizen retains its existing SettingsState, session authority, launch preference and browse focus owners.
No server or Apple source changes are required by this supported subset.

| Apple source | Rows, values and ownership | Tizen candidate |
| --- | --- | --- |
| `tvOS/Screens/Settings/TVSettingsView.swift:141-225` | 490-point rail, 52-point gap; profile card, General, Playback, Subtitles, conditional Diagnostics, Server, Sign Out, Silo version | Profile card shows the active profile and account line; General, Playback, Subtitles and Server are present; Diagnostics stays out until #218; Sign Out confirmation and package version are present |
| `tvOS/Screens/Settings/TVGeneralSettingsView.swift:23` | APPLE TV USER: Paired Silo Profile; PROFILE AT LAUNCH: Profile Selection | Launch picker offers Automatic and Every Time through the existing protected launch owner; no Apple TV OS user pairing |
| `Shared/ProfileLaunchBehavior.swift:5` | Automatic, Every Time, After 1 Hour, After 12 Hours | All four choices use the existing protected ProfileLaunch owner; Automatic uses the last profile on Samsung because there is no Apple TV OS user pairing. |
| `tvOS/Screens/Settings/TVGeneralSettingsView.swift:166` | TITLE PAGES: Show Title Art, Apply to All Devices, each On/Off | Existing title-art owner and profile/device reconciliation retained |
| `tvOS/Screens/Settings/TVGeneralSettingsView.swift:50-126` | THEME MUSIC: Play Theme Music, Loop Theme Music; SYNC SOURCE: Use Synced TV Settings; CARDS & POSTERS: Show Advisory Age, Poster Size, Use Profile Default; TOP MENU: Show Audiobooks | Advisory age and TV-family poster editing are supported, including clearing older device overrides and Use Profile Default before the footer. Theme music has no playback owner. Show Audiobooks remains with open PR #230, which supplies the navigation switch and audiobook player. |
| `tvOS/Screens/Settings/TVPlaybackSettingsView.swift:66` | QUALITY: Resolution, Maximum Bitrate, conditional Lower quality when buffering and learned limit Reset; CONNECTION: Connection Speed and test | Resolution, Maximum Bitrate and Connection speed are supported. Test speed measures on press and shows the stored reading. Playback start still sends only `quality_preference` and `bandwidth_cap_kbps`. Apple also sends `bandwidthEstimateKbps` (`PlayerViewModel.swift:6214-6218`, `PlaybackSessionBridge.swift:1180-1191`). Learned-limit and buffering policy controls stay omitted. See [Settings rows](../settings.md). |
| `Networking/SiloQualityPresets.swift:146` | Resolution order Auto, 4K, 1080p, 720p, 480p; bitrate caps 200000, 100000, 60000, 40000, 20000, 15000, 10000, 6000, 4000, 2000, 1500 kbps plus No limit | Same named choices, filtered by server support. A stored cap outside that list stays in descending order and selected. Caps under 1000 kbps use Apple's kbps label. The picker has no separate kbps field |
| `tvOS/Screens/Settings/TVSettingsComponents.swift:44` | Audio Language from server options; device Use Profile Setting first; legacy No preference retained only when stored | Device scope, legacy null and individual inherited resets retained; language display currently follows server tags |
| `tvOS/Screens/Settings/TVPlaybackSettingsView.swift:174` | STREAMING: Audio Language, HDR, Dolby Vision, Seek Cache, Buffer Ahead, Lossless Multichannel Audio, TrueHD Atmos and DTS:X, Deinterlacing, Deinterlacing Field Rate | Only Audio Language offered; other controls need verified AVPlay equivalents and plan/capability consumption, not Apple-only stored settings |
| `tvOS/Screens/Settings/TVPlaybackSettingsView.swift:262-290` | EPISODES: Auto-Play Next Episode, Show Next Up, Skip Intros, Skip Credits | All four rows are consumed by PlaybackController. Show Next Up offers At end, 10 seconds, 30 seconds, 1 minute and 2 minutes before end, with device override and profile inheritance. |
| `tvOS/Screens/Settings/TVPlaybackSettingsView.swift:297-312` | SPOILERS: Blur unwatched episode images, Hide unwatched episode descriptions; profile-wide, revision 17, only unstarted episodes | Remains with #212; no switches are exposed before its episode consumers exist. |
| `tvOS/Screens/Settings/TVPlaybackSettingsView.swift:329-343` | VIDEO and AUDIOBOOKS: Skip Back and Skip Forward; 5, 10, 15, 30, 45, 60, 90 seconds | VIDEO editors restored after the 6 November full-scroll comparison confirmed the running Apple app has these rows. Playback reads server effective intervals (10 s back / 30 s forward defaults); audiobook rows remain with the player in open PR #230. |
| `tvOS/Screens/Settings/TVPlaybackSettingsView.swift:408-429` | RESET: Use Profile Settings with confirmation | Clears only supported device playback overrides through the existing confirmed writer, preserving profile defaults and profile-owned video intervals. Stops on a failed confirmation; Retry reconciles the failed row and resumes the remaining reset. |
| `tvOS/Screens/Settings/TVSubtitleSettingsView.swift:37` | PROFILE: Language, Behavior, Show Forced Subtitles; conditional METADATA: Metadata Language | Language, Behavior and Show Forced Subtitles write `playback.subtitle_language`, `playback.subtitle_mode` and `playback.show_forced_subtitles` at profile scope. Metadata Language is offered in Subtitles under METADATA only when metadata AI is enabled, matching `TVSubtitleSettingsView.swift:18-20,85-102`; it invalidates catalog caches after confirmed changes |
| `tvOS/Screens/Settings/TVSubtitleSettingsView.swift:103` | APPEARANCE: preview, Use Device Settings, Only on This Apple TV, Font Size/Family/Color, Text Opacity, Text Outline, Outline Color, Background Style/Opacity/Color, Position, Reset Appearance confirmation | Preview, scoped appearance writer, renderer and Reset are present. Use Device Settings stays omitted: Samsung has no established equivalent of the tvOS Accessibility caption bridge |
| `tvOS/Screens/Settings/TVDiagnosticsSettingsPane.swift:12` | FEATURE STATE Status/Destination; CAPTURE Send Reports To, Debug Logging, Crash Reports (Ask/Always/Never); pending reports, Send Diagnostics Now, sent history, None empty states | No Diagnostics pane: needs consent, redaction, capture, queue, expiry, destination and upload owners (#137) |
| `tvOS/Screens/Settings/TVSettingsView.swift:499-561` | ACTIVE SERVER Server/Address, Accounts; ABOUT App Version, Privacy Policy, Acknowledgements | Server/version info, Accounts owns server management, so its duplicate Manage Servers row is omitted. Privacy QR and credits are present; Watch Party remains gated by #54 |
| `tvOS/Screens/Settings/TVSettingsView.swift:267-281` | Sign Out invokes the shared account sign-out owner | Samsung retains its signed-recheck-passed confirmation: `Sign out of {account} on {server}?` with Cancel focused and Sign Out. The message says the server stays saved, because logout clears the account and does not remove the saved server |

Apple focus follows `docs/tvos-focus.md:131`: Up/Down stays in the current pane; focus on a category previews its pane; Right/OK enters the first available control; Left/Back returns to that category.
Back from a picker restores its invoking row; cancelling Sign Out restores Sign Out; Back from the rail exits Settings to Home.
Tizen retains its existing return-to-origin browse behavior, which requires native comparison with Apple's Home exit.
Apple load binds the active profile and refreshes playback/profile values (`Screens/Settings/SettingsViewModel.swift:330`).
General independently refreshes title art, theme music and interface preferences; Playback independently refreshes intervals, spoilers and connection state.
Read/write errors and held changes appear as footers with Retry/Discard; unavailable features are gated and empty report lists read None.
Tizen keeps its existing Loading settings/Saving, error, Reload settings and uncertain-write Check and retry states; it does not copy Apple's held-write queue.

### Native capture sequence (not executed)

Use the same server, profile, content and saved values on both clients.
Record the installed Apple build separately from the source revision above.
Build/sign the Samsung WGT, record its hash and verify the loaded assets before capture.
Capture actual dimensions without resizing; record remote movement for focus and timing.

1. Open the avatar/profile menu, select Settings, and capture entry on General.
   Capture Profile Selection with Automatic selected, then Every Time; Back must restore the row.
   Capture Show Title Art and Apply to All Devices with identical booleans.
2. Focus Playback in the rail, capture its preview, press Right and capture Resolution focused.
   Open Resolution and capture Auto, 4K and 1080p; cancel and capture the restored Resolution row.
   Open Maximum Bitrate and capture 6 Mbps and No limit; use a stored uncommon cap for a separate capture.
3. Use profile defaults Audio=fr, Resolution=1080p and bitrate=6000, with device overrides Audio=yue-Hant-HK, Resolution=480p and bitrate=null.
   Capture each picker and its inherited reset; clear each override and verify the profile values did not change.
   Capture VIDEO Skip Back=10 seconds and Skip Forward=30 seconds, then 15/45 and the restored focus after each choice.
   Focus Subtitles. Capture Language None, Behavior Auto and Show Forced Subtitles On, then a changed value and Back to that row.
4. Disconnect the server before opening Settings and capture loading, failure and Reload settings; reconnect and capture recovery.
   Separately interrupt a fake/test write response and capture Check and retry without a duplicate write.
   Never change production preferences solely to obtain this proof.
5. Capture Server/version and Acknowledgements; scroll Down/Up, Back and verify row restoration.
   Capture the profile card name and account line, and the version line under the rail.
   Focus Sign Out, open the confirmation with Cancel focused, Cancel, and capture Sign Out focused again.
   Select the profile card and verify the existing profile picker; do not confirm sign out on a live account for this capture.

Native comparison, signed-package proof and physical-TV acceptance remain outstanding.
This source candidate does not close #104, #137 or #177.

## Manual episode completion

Issue #12's bounded first slice offers Play next and Back only after a natural episode EOF.
PlaybackController retires the transport and waits for an in-flight progress request before sending STOP with a newer sequence and the last observed source position.
The adopted plan's effective file and source timeline identify the completed edition; unknown or different durations and early EOF never manufacture a full-duration sample.
Uncertain STOP answers retry the identical installation ID, stop ID, sequence, position and body, preserving Retry-After.
An explicit Retry after exhausted transient retries retains that same request.
An expired session during final progress or STOP reporting offers Back without an unusable Retry.
Fresh watch-read failures remain retryable after STOP is confirmed.
EOF during a pending track or quality change is retained when a refusal keeps the original transport; adopting a replacement discards that predecessor's EOF.
Authorization, installation and administrator refusals cannot create a successor session.

A valid STOP receipt is a teardown barrier, not proof that progress or watch-history side effects succeeded.
Fresh watch reads follow the receipt and precede any next offer.
The panel says Playback ended even when fresh played state remains false or the contract's optional progress is absent.
No separate mark-watched write is sent.
Failed or malformed reads show Retry and Back rather than reporting exhaustion or a saved state.

The resolver checks current identity and the effective version's explicit multi-episode range, then sorts returned numeric season and episode fields.
Successful empty or unreadable permitted media are skipped; failed requests are errors.
Regular sequences skip specials, while explicitly playing specials continues only within that season.
The next title needs both an authorized episode row and a fresh permitted readable version.
Watched episodes are still eligible; confirmed partial progress may resume, otherwise START receives explicit numeric zero.
Play next uses the existing planner with a fresh attempt and no previous file's audio or edition selection.
Movies return to Browse after confirmed teardown; exhausted episode sequences retain a focusable Back action.

Back, backgrounding, teardown and authority changes cancel continuation and fence late answers.
Remote focus stays reachable during finalization, resolution, failure and exhaustion; focus movement sends no reads.
Autoplay adds a ten-second countdown with Cancel when the profile's autoplay setting is on; see [Series autoplay](series-autoplay.md).
There is no pre-EOF prompt, saved autoplay editor, credits policy, queue or cross-title fallback.

The source contracts are pinned to [server cc85149](https://github.com/Artic0din/silo-server/tree/cc8514943289045e7b9f7ac8d36d4968bfe93926), including WatchDetail, WatchFileVersion, Season, Episode and PlaybackMutation in OpenAPI and the stop finalization handler.
Behavioral tests use synthetic server data and fake AVPlay.
This source candidate does not close issue #12: signed packaging, real-TV movie EOF and cross-episode playback, AVPlay teardown/start recording, Tizen 8.0 hardware and store acceptance remain parent-owned validation gates.

## Quality and seek controls

Playback Settings also offers separate video rewind and fast-forward intervals.
The profile-only remote keys are `player.video_skip_back_seconds` and `player.video_skip_forward_seconds`, introduced in settings manifest revision 9.
Their numeric choices are 5, 10, 15, 30, 45, 60 and 90 seconds, with inherited defaults of 10 and 30 seconds.
The controls use server labels, display explicit and effective values, and reset one key with DELETE.
They reuse Settings' pre-write read, post-write confirmation, uncertain-answer reconciliation, busy lock, Retry-After and profile authority fences.

The controller discovers the supported pair before each start and carries it in PlaybackView to buttons, repeated Left/Right previews and dedicated Rewind/Fast Forward keys.
Settings capability revision remains opaque; numeric manifest, definition and option revisions negotiate support.
Effective reads batch only when advertised; otherwise supported settings use single-key reads, including quality and cap through the unchanged playback-default decoder.
Servers without seek support retain the existing 10/10 behavior and labels.
A network or malformed supported seek read blocks startup with a visible Retry; it never fabricates saved defaults.
The approved Tizen adoption applies only to these two known video keys despite advisory platform metadata omitting Tizen; other platform filters and client identity are unchanged.

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
Playback Settings edits supported device overrides or profile-only defaults through the existing Settings owner described below.

Auto remains selected when the session requests Auto, regardless of the delivered rung.
For a fixed preference, `plan_active_quality_v1` makes only a returned, offered `active_quality` authoritative.
With that feature and no active quality, nothing is highlighted.
Without it, only a matching explicit in-player pick is highlighted.
Resolution and bitrate are never used to guess delivery.

A quality change uses the existing serialized replan path with operation `quality_change`, source position, effective-file tracks, and unchanged opaque plan identities.
It clears route failure exclusions, keeps the playback attempt ID and gives the logical change one request ID, reused with an identical body on bounded retries.
Subtitle Off stays omitted and returned effective-file selections are adopted without remapping ordinals.
The latest local pause intent during the pending request is applied to replacement playback.
The existing physical seek barrier, progress reporting, visibility suspension and authority cancellation still own transport lifetime.

Only a confirmed `adaptation_unavailable` keeps the predecessor transport and preference.
Unanswered transient quality or track changes join bounded connection recovery after their identical-request retries are exhausted.
Invalid successes and generic quality-replan 409 conflicts still end the attempt.
A playable replacement retires the predecessor on the server; load failure recovers against the replacement identity or ends playback, never reopening the predecessor.

Contracts were checked against [server cc85149](https://github.com/Silo-Server/silo-server/tree/cc8514943289045e7b9f7ac8d36d4968bfe93926) and [canonical Apple quality rules](https://github.com/Silo-Server/silo-apple/blob/148d5d70f8b8ce982a827fead2b16f8de40f0f57/iosApp/iosApp/Screens/Player/ApplePlaybackQuality.swift).

### Lifecycle and connection recovery

Visibility hide suspends the active AVPlay pipeline and cancels its timers.
Show rechecks capabilities, installation, profile authority and media authorization before restoring playback.
Preparing transports cannot play while that foreground check is pending; obsolete restore callbacks cannot bypass a newer check.
Play and pause during that check keep the latest intent and do not call AVPlay or show transport controls until restoration finishes.
Visibility changes keep an in-flight recovery request serialized; its accepted plan waits for foreground validation before opening a transport.
An initial capability read establishes authority before foreground restoration compares installation identities.
Hiding during a local seek defers native suspension until that seek settles, retaining its actual resulting position.
Retiring a pipeline clears its suspension state; a deferred replacement opens with a new listener, and old native restore callbacks cannot mark it started.
Hidden startup and reconnect deadlines are rearmed from the clock instead of relying on background timers.
An already prepared READY pipeline resumes with play or pause, because AVPlay restoreAsync is not valid in READY.
The explicit controller background() action remains a terminal stop; visibility events use suspend/restore instead.
A cold launch has no in-memory pipeline and uses the normal fresh server resume path.

After an established transport loses its connection, the controller keeps source position, current tracks and playing or paused intent.
Recovery sends a no-op track_change rather than reporting a failed route.
An unanswered recovery replan retains its request identity and identical body until a definitive answer, allowing the server to replay an accepted decision.
Temporary login-refresh unavailability remains inside the recovery budget and does not force re-login.
The twelve waits are 1, 2, 4, 8 and then eight 15-second waits: 135 seconds of waiting, excluding request time.
Longer server Retry-After cooldowns extend those waits and remain in force across visibility changes and manual Retry.
A loss within 30 seconds of replacement playback carries the existing budget; an API response alone does not establish stable playback.
A replacement that fails before playing follows ordinary route recovery; if that recovery cannot reach the server, it rejoins the same reconnect budget.
Exhaustion exposes Retry and Back instead of starting another automatic cycle.
An app return preserves that exhausted error until explicit Retry, including exhaustion during foreground validation.

A missing session may create one replacement START at the saved position and tracks.
Its unanswered retries retain the same body and attempt identity.
When a stale plan requires a fresh session, accepting its replacement also sends a sequenced STOP for the possibly live predecessor.
A 404 proves the predecessor is already gone and needs no cleanup STOP.
A missing session during an active reconnect schedules one replacement when no recovery request is still in flight.
Recovery classifies each answer by its dispatched operation, even when a concurrent progress answer changes the pending recovery step.
Progress answers belong to their dispatched session and cannot end or restart a successor; predecessor teardown still waits for its own pending progress.
User replan answers are also fenced to their dispatched transport and session, and adopting a replacement clears interrupted seek state.
If its playable answer arrives after Back or teardown, cleanup stops that new session with its own sequence and STOP identity.
An admin-ended session, changed installation or revoked authority is terminal and does not silently create a replacement.
Back, teardown, another playback and authority loss fence late recovery work.
Hiding during next-episode resolution still cancels continuation; recovery does not autoplay a successor.

Native fake-server and desktop tests establish the state, identity, timing and cancellation rules above.
Actual Samsung suspend/restore, audible recovery, decoded frames, live-server restart behavior and the cross-device acceptance matrix remain unverified.
The existing Skyline tokens and Chrome 108-compatible list layout are reused.

## Saved Playback settings

Profile menu → Settings → Playback offers Resolution, Maximum Bitrate, Audio Language, Skip Back and Skip Forward.
General → Hidden libraries retains the same owner and readback behaviour.
Quality choices are filtered by the supported server manifest and use Apple's order and labels: Auto, 4K, 1080p, 720p and 480p.
Deprecated Original and unfamiliar stored strings are displayed as current values, without becoming new choices or being rewritten during a read.
New profiles inherit Auto and no cap.

Maximum Bitrate offers Apple's discrete caps. A stored cap that is not in that list stays in descending order and selected. The picker has no separate kbps field or Save action.
No limit writes JSON null; Use Profile Setting deletes only this device's row when device scope is advertised.
Profile-only definitions retain Use inherited default and delete only the profile row.
Remote Back returns focus to the Maximum Bitrate row.

Explicit profile defaults, this TV's overrides and the effective value/source remain separate.
Audio Language, Resolution and Maximum Bitrate edit this device only when both the discovered definition and capabilities advertise `profile_device`; otherwise they retain profile scope.
Both seek intervals remain profile-only.
Use Profile Setting clears only the device row, revealing the profile or server default.
Audio library and series choices may still take priority.
Device audio pickers offer No preference only for a legacy stored null, which remains selected without rewriting it; a new no-preference save clears the device row.
These writes retain the captured profile proof and stable device headers through the existing API/session owner.
Writes are never automatically resent; uncertain answers reconcile the explicit row and effective value before a user-triggered retry.
Profile authority changes discard late answers and remove the screen.
Unsupported capabilities, platforms, schema shapes or profile scopes do not expose these controls.

The pinned [Apple TV Settings](https://github.com/Silo-Server/silo-apple/blob/9723df007baa8e933f5615cc14b13e99a6ee1ea1/iosApp/iosApp/tvOS/Screens/Settings/TVPlaybackSettingsView.swift) separates resolution and bitrate into two pickers.
Its [quality presets](https://github.com/Silo-Server/silo-apple/blob/9723df007baa8e933f5615cc14b13e99a6ee1ea1/iosApp/iosApp/Networking/SiloQualityPresets.swift) offer discrete bitrate choices and keep a stored cap that is not in the list.
This Tizen picker matches that list.
The #104 scope candidate follows [Apple's device selection owner](https://github.com/Silo-Server/silo-apple/blob/9723df007baa8e933f5615cc14b13e99a6ee1ea1/iosApp/iosApp/Screens/Settings/SettingsViewModel.swift#L742) and the pinned server revision 24 scopes.
Native Apple/Samsung comparison remains pending; this candidate does not close #104 or establish Settings parity.
The binding [Skyline guide](https://github.com/Silo-Server/silo-apple/blob/148d5d70f8b8ce982a827fead2b16f8de40f0f57/docs/skyline-design-guide.md) has SHA-256 `2d42d292e01ab6ee539278b63c286756fc432edf876a9286a33c9e853672cac2`.
The selected fixture definitions remain an exact subset of the pinned public manifest; provenance is recorded in the contract README.

Native tests write and read back Settings, then start the real PlaybackController repeatedly and assert exact quality and bandwidth request fields.
The player reads these defaults before every start and publishes the confirmed seek pair through its existing view.
Native fake-server tests and synthetic desktop captures do not prove real server playback, Chromium 108 rendering, Tizen software emulator behaviour or Samsung TV playback.
Device override editing, automatic subtitle resolution, trickplay and playback-planner redesign remain outside this slice.
Issue 29 and whole-app acceptance remain incomplete.
