# App behaviour

How the packaged app behaves today, and what has and has not been proven on a TV.

## Native app

The packaged app uses Silo's native `/api/v2`: server entry, device-code sign-in with a password fallback, household profiles and PINs, Movies and Series browsing, and AVPlay playback with audio and subtitle selection.

The [Requests journeys](requests.md) appear when the server enables Requests for the active viewer.
The earlier Jellyfin-compatible client is retired.
Sign-in uses an eight-digit device code approved on Silo's web page, with "Sign in with a password" one press away as on the Apple TV app.
The password is sent only in the body of `login` and is never stored; only the issued tokens are kept.
The server address is remembered publicly; credentials use Tizen KeyManager or the explicit session-only mode when protected storage is unavailable.

`src/main.ts` boots the app through `src/bootstrap.ts` and `src/platform.ts`.
`src/app.ts` composes the screen controllers without owning their network or credential logic.
The profile controller remains active while browsing and playback use its profile authority.
When that authority ends, the app removes the old content before the profile controller takes the screen back.
Player Back, movie completion and dismissed errors return to the same browse view and focus.
Natural episode completion waits for the final STOP receipt and fresh authorized watch data, then offers manual Play next or Back.
See [playback completion](playback-quality.md#manual-episode-completion) for ordering and validation limits.
Back from Home or library content returns to the navigation bar, then selects Home, then opens an Exit/Cancel dialog.
Modal keys do not reach the screen underneath.

## Interface

The TV interface follows the [Skyline design guide](https://github.com/Silo-Server/silo-apple/blob/main/docs/skyline-design-guide.md).
`src/theme.css` owns the shared OLED palette, type family and motion durations.
Sign-in, profiles, dialogs and playback use monochrome focus states and respect the system Reduced Motion preference.
The launcher uses the existing Silo app artwork.
Samsung's supported Play/Pause, Play, Pause, Stop, Rewind and Fast Forward keys are registered independently; Enter remains available on every remote.
Player Up focuses the visible transport controls.
Left and Right preview a seek without changing playback; Enter commits the source position and Back cancels.
Dedicated Rewind and Fast Forward keys use the separate profile-saved video intervals, also used by transport buttons and Left/Right previews.
Supported servers inherit 10 seconds backward and 30 seconds forward; unsupported servers retain ten seconds in each direction.
The mounted Skyline bar groups visible libraries into Movies and Series tabs, with anchored library and profile menus.
Library scope is remembered per server, profile and content type.
Card focus drives a passive preview without fetching details; scrolling retargets immediately and respects Reduced Motion.
See [Skyline browse behavior](skyline-browse-shell.md) for the implemented section boundary.

## Validation limits

The composed app is covered in desktop Chromium with fake Silo and AVPlay implementations, including the actual production bootstrap.
This is not TV playback or IME proof.
Earlier signed diagnostics on the S95C running Tizen 9 proved normal-HTTPS discovery/authenticated reads and direct playback with picture, dialogue, a 60-second resume, forward seek and progress.
The composed debug-signed app was then checked on the same S95C: device-code approval, real profile and catalog reads, account restoration after a full exit/relaunch, AVPlay start/pause/forward and backward seeking, an audio-track replan, return to the title, and sign-out with server revocation.
AVPlay state and server responses were observed; picture, dialogue and audible track differences were not independently confirmed during that composed-app run.
The TV keyboard, minimum-version Tizen 8.0 hardware, store builds, full remux/transcode acceptance and audible/visible track acceptance remain open.

The client declares no subtitle renderer.
Movie and episode Details offer Audio Auto or an explicit track from the displayed file, for this attempt only.
Changing version clears that track choice; explicitly choosing a version pins its source through playback.
Resume checks fresh profile progress for up to three seconds; Play from start sends source position zero.
See [preplay behavior](skyline-browse-shell.md#preplay-audio-and-resume) for fallback, cancellation and persistence limits.
The server can burn embedded subtitles into video when transcoding is allowed; external and downloaded subtitles receive an explicit unsupported result.
Visibility changes suspend the active pipeline and revalidate authority and media authorization before restoring it.
Mid-stream connection loss pauses playback and retries at the saved source position with bounded backoff, preserving playing or paused intent.
Cold launches use the normal server resume flow; they do not restore an in-memory pipeline.
See [playback recovery](playback-quality.md#lifecycle-and-connection-recovery) for cancellation, terminal errors and remaining hardware acceptance under [#13](https://github.com/Artic0din/silo-tizen/issues/13).
