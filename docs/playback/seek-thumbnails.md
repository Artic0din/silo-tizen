# Seek thumbnails

The existing cancellable seek preview now optionally displays the server's JPEG thumbnail at the preview's source timestamp.
Left/Right or the visible seek buttons request a preview; Enter commits the existing seek command and Back cancels it.
The image is decorative, never takes focus, and adds no controls or explanatory copy.
Unsupported, unavailable, malformed, expired or failed previews leave timestamp seeking usable.
This slice does not complete issue 29 or whole-app acceptance.

## Contract and ownership

The sources are [silo-server at cc851494](https://github.com/Silo-Server/silo-server/tree/cc8514943289045e7b9f7ac8d36d4968bfe93926) and canonical [silo-apple at 148d5d70](https://github.com/Silo-Server/silo-apple/tree/148d5d70f8b8ce982a827fead2b16f8de40f0f57).
The binding [Skyline guide](https://github.com/Silo-Server/silo-apple/blob/148d5d70f8b8ce982a827fead2b16f8de40f0f57/docs/skyline-design-guide.md) has SHA-256 `2d42d292e01ab6ee539278b63c286756fc432edf876a9286a33c9e853672cac2`.
Playback remains full screen and reuses the existing monochrome tokens and player controls.

The playback controller remains the only owner of planning, session identity, auth, transport, progress and seeking.
It enables thumbnails only when playback capabilities advertise `trickplay_v1` and watch state explicitly marks the adopted plan's `effective_media_file_id` as `trickplay_available: true`.
Catalog versions do not contain that flag.
Both watch reads use the existing profile-scoped session transport, its captured authority and stable device headers.
The content ID is path-encoded and the effective file ID is query-encoded.
No preview reads occur on ordinary focus navigation or playback startup.

The manifest decoder validates file identity, positive safe integer geometry, interval and count, arithmetic overflow, expiry, exact sheet coverage, unique contiguous indexes and HTTPS URLs.
Root-relative signed URLs resolve against the server origin, retaining its port.
Absolute HTTPS storage URLs may use another origin.
Their path and query remain opaque; no account/profile headers, device headers or token query are added.
The exact public server fixtures `get_watch_state_ok.json` and `get_watch_trickplay_ok.json` are vendored unchanged at `src/contracts/v2/SOURCE`.
Tests explicitly vary the watch availability and expiry; the pinned watch fixture itself advertises false.

Source-time lookup uses the containing interval and clamps to the final valid thumbnail, excluding final-sheet padding.
For the server fixture, 1,235 seconds selects index 123, sheet 1, and crop `(900, 252, 300, 126)`.
The screen holds one decoded sheet plus at most one loading replacement, validates its decoded geometry and clips it to one cell.
There is no persistent cache, local extraction, snapshot seek or capability advertisement change.

## Cancellation and failure

New targets cancel the previous request.
Attempt, adopted plan, authority and target fences prevent stale answers from painting after cancel, commit, file change, replan, profile change, backgrounding or teardown.
The thumbnail provider never commits a seek.
The existing dedicated media keys, pause behavior, quality barriers and uncancellable AVPlay seek barrier remain in the controller.

Manifests renew within 30 seconds of expiry; an already-expired response cannot load a sheet.
A failed image renews the manifest and retries once.
DOM image errors do not expose HTTP status, so that bounded retry also covers 401/403, other statuses and offline failures.
An error status with a decodable JPEG body can still fire `load` in Chromium; this path reacts to image failures, not an independently observed sheet status.
After failure, previews back off for 30 seconds within the adopted plan.
Manifest 404 is unavailability for this file, not evidence that the server lacks trickplay support.
The existing transport owns its normal safe-read retry for transient manifest errors such as 503.
Images time out after 15 seconds and failures remain silent decoration failures.

## Validation limits

Native tests use coherent fake watch and playback operations around the pinned contracts.
Desktop Chromium tests use the real session transport, controller and image loader with generated JPEG sheets and a synthetic AVPlay implementation.
They verify decoded geometry, crop placement, signed cross-origin requests without application credentials, focus, cancellation and timestamp fallback.
Routed same-origin API requests do not prove packaged Tizen browser-origin CORS, TLS deployment, redirected storage behavior or real-server availability.
Plain image loading does not require canvas pixel access; no `crossorigin` attribute or account credentials are attached.
The [HTML image processing model](https://html.spec.whatwg.org/multipage/images.html#updating-the-image-data) also distinguishes image decoding from the underlying response status.
No TV, simulator, decoder, audible playback or physical remote acceptance is claimed.
