# Series autoplay

Issue [#12](https://github.com/Artic0din/silo-tizen/issues/12) extends manual next-episode continuation with a ten-second countdown and Cancel autoplay control.
This work originally stacked on `origin/feat/markers-skip-intro` at `f64c773cea25f88844959b10224c8003f133903f` and was rebased onto `origin/main` after PR #63 squash-merged as `5fceaad`.

The pinned server settings manifest at `cc8514943289045e7b9f7ac8d36d4968bfe93926` defines `playback.auto_play_next` as a remote boolean, introduced in revision 1, default true.
Its resolution order is `profile_device`, `profile`, `default`.
The player discovers the definition and reads its effective value through the existing profile-scoped adapter; it never writes the setting.
Absent, incompatible, unreadable or false preferences leave continuation manual.

Only natural AVPlay completion enters this path.
Pending progress and the final stop receipt settle before a fresh authorized next-episode resolution.
The countdown starts only with a playable successor and confirmed stop, including across season boundaries.
No successor means no countdown; resolution or stop failures retain the existing retry and Back behavior.
Cancel stops the timer but preserves Play next.
Manual Play next and timer expiry use the same controller handoff, preventing duplicate starts.
Back, destruction, suspension and authority changes cancel continuation.
Recovery does not start a countdown: the existing transport and recovery callback barriers determine natural completion.

Native tests cover stop ordering, countdown timing, cancellation, disabled preference, authority changes and suspension.
Desktop Chromium tests cover countdown updates and D-pad cancellation.
Real Samsung AVPlay, physical remote, signed WGT and emulator validation are not established by those tests.
