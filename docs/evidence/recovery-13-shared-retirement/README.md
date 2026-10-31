# Playback recovery evidence

Baseline: `ac706856b0325613f0149d60661a5bc227fe7343`.
Head: `5a2106e3644e1abe92a0528d628a6d2bb50754ae`.
Approved source tree: `bb41bee8edcb7fb959bf39d8caa42505c96a2887`.

These 1920×1080 captures use the same synthetic movie and server fixtures.
Head HTML, JavaScript and CSS were read from the signed package and matched its staged files.
The baseline uses the unchanged main build.

- `main-before-hide.png` and `head-before-hide.png`: playback at 32 seconds.
- `main-after-return.png`: backgrounding stopped playback and required selecting the title again.
- `head-restoring.png` and `head-after-return.png`: foreground authorization check, then the same session restored at 32 seconds without another START.
- `head-reconnecting.png` and `head-recovered.png`: connection loss, a lost accepted replan answer, then an identical-request replay at 32 seconds with one START and no recovery STOP.
- `head-session-replaced.png`: a held progress 404 arrives while hidden; show opens one replacement session without restoring its closed predecessor, and the new listener reports 33 seconds.
- `recovery-journey.mp4`: 18.0-second real-time head journey, including return, a held local seek that settles while hidden, lost-answer replay, hidden-session replacement and remote Back.

The AVPlay implementation is a black desktop stub.
These captures prove presentation and command routing; they do not prove decoded picture, audible audio, Samsung suspend/restore, live-server restart behavior or first-frame performance.
Normal and reduced-motion behavior are covered by automated production-entry tests; this recording uses normal motion.

These files are retained on a dedicated evidence branch in this repository and are not app assets.
No package, certificate, account, deployment address or private server media is included.
