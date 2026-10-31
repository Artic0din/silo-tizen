# Playback recovery evidence

Baseline: `ac706856b0325613f0149d60661a5bc227fe7343`.
Head: `860eb036431b514fe463aa1e55ba50c240912618`.
Approved source tree: `93a7f2e0e5a10802c4d2a6129b153716251d5b14`.

These 1920×1080 captures use the same synthetic movie and server fixtures.
Head HTML, JavaScript and CSS were read from the signed package and matched its staged files.
The baseline uses the unchanged main build.

- `main-before-hide.png` and `head-before-hide.png`: playback at 32 seconds.
- `main-after-return.png`: backgrounding stopped playback and required selecting the title again.
- `head-restoring.png` and `head-after-return.png`: foreground authorization check, then the same session restored at 32 seconds without another START.
- `head-reconnecting.png` and `head-recovered.png`: connection loss, a temporary server failure, then a no-op track-change recovery at 32 seconds in the same session.
- `recovery-journey.mp4`: 7.8-second real-time head journey, including return, reconnect and remote Back.

The AVPlay implementation is a black desktop stub.
These captures prove presentation and command routing; they do not prove decoded picture, audible audio, Samsung suspend/restore, live-server restart behavior or first-frame performance.
Normal and reduced-motion behavior are covered by automated production-entry tests; this recording uses normal motion.

These files are retained on a dedicated evidence branch in this repository and are not app assets.
No package, certificate, account, deployment address or private server media is included.
