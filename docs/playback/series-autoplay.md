# Series autoplay

Issue [#12](https://github.com/Artic0din/silo-tizen/issues/12) extends manual next-episode continuation with a ten-second countdown and Cancel autoplay control.
This work originally stacked on `origin/feat/markers-skip-intro` at `f64c773cea25f88844959b10224c8003f133903f` and was rebased onto `origin/main` after PR #63 squash-merged as `5fceaad`.

The pinned server settings manifest at `cc8514943289045e7b9f7ac8d36d4968bfe93926` defines `playback.auto_play_next` as a remote boolean, introduced in revision 1, default true.
Its resolution order is `profile_device`, `profile`, `default`.
The player discovers the definition and reads its effective value through the existing profile-scoped adapter; it never writes the setting.
Absent, incompatible, unreadable or false preferences leave continuation manual.

The pre-end panel uses `playback.next_up_prompt_seconds`, with Apple's default of 30 seconds.
The tvOS timing choices are At end (0), 10, 30, 60 and 120 seconds; the contract accepts every integer from 0 through 120.
Play Now finalizes the current session before starting its successor.
Inside the prompt window, progress and the final stop report the duration, following Apple's completion policy.
Keep Watching dismisses the panel for this prompt window and resumes playback.
Back does the same; after EOF it starts the current title's final ten seconds through a fresh authorized playback attempt.
The EOF screen retains the first twelve distinct On Deck candidates in server order, excluding the current title and series.
On Deck also appears after movies, and its titles require explicit selection.

Natural AVPlay completion enters the final-stop path.
Pending progress and the final stop receipt settle before a fresh authorized next-episode resolution.
Autoplay is re-read after the final stop, with failures leaving continuation manual.
The countdown starts only with a playable successor and confirmed stop, including across season boundaries.
When the pre-end panel was already visible, an enabled successor starts after the final stop without a second countdown.
No successor means no countdown; resolution or stop failures retain the existing retry and Back behavior.
Cancel stops the timer but preserves Play Now.
Manual Play Now and timer expiry use the same controller handoff, preventing duplicate starts.
Back, destruction, suspension and authority changes cancel continuation.
Recovery does not start a countdown: the existing transport and recovery callback barriers determine natural completion.

Native tests cover stop ordering, prompt choices, countdown timing, cancellation, disabled preference, late settings answers, authority changes and suspension.
Desktop Chromium tests cover countdown updates and D-pad cancellation.
Real Samsung AVPlay, physical remote, signed WGT and emulator validation are not established by those tests.

Apple source reference: `Silo-Server/silo-apple` commit `2c03722c3eecee64c74272258190f13e3258d959`.
`PlayerView.swift:1408-1530` defines tvOS actions, `1595-1602` the eyebrow, and `1159-1175` the On Deck row.
`TVSettingsComponents.swift:72-78` defines timing choices; `PlayerSettings.swift:790-792,1659-1660` sets the default.
`PlayerNextUpCompletionPolicy.swift:18-80` defines the completion window and reported position.
`PlayerViewModel.swift:3591-3596,3702-3729,4050-4087` covers movies, the twelve-candidate cap and Back.
Same-state Apple/Samsung comparison is pending; the PR must remain unmerged until it passes.
