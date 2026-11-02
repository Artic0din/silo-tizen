# Library discovery

Movies and Series each keep one selected library using the existing server/profile storage key.
Browse opens the server's library sections; each section opens a bounded catalog view.
Browse inserts up to eight curated collections by descending item count after the first server items section, followed by See All.
Collections preserves server groups and order, including opted-in personal collections, in a three-column fan-card grid.
Each card uses the single poster or collage supplied by the server, without inventing additional posters.
Personal collection contents use `POST /catalog/query` with `source=user_collection`, `collection_id` and the current library scope.
Genres keeps filtered results and sort controls under the persistent library pills.
A–Z uses the server's letters, counts and positions with its query window cursor.
Recently Added requests `added_at` descending.
Expanded Home and library section rows read 60 cards at a time into one scrolling grid, reading more when the last six cards enter the viewport.
Section queries send only their Home/library scope, section id, optional library id, limit and cursor, matching Apple's `sectionItems` builder; media filtering stays local because the server rejects query overlays on section sources.
They retain loaded depth through Details and refresh explicitly invalidated state from the beginning through that depth.
Other catalog and collection pages still contain at most 24 cards.
Section previews show at most 24 cards; their complete contents open through the section action.

## Expanded-row simulator evidence

The [Compact comparison](screenshots/117-section/section-comparison.png) pairs this candidate's Samsung simulator frame with the historical Apple `New Releases` frame at the pinned `1a7ccee` source revision, with the same first six titles and focused card.
Apple's native 960×540 preview is shown at 100%; Tizen's native 1920×1080 capture is shown at 50%, without upscaling either image.
The Apple frame was not recaptured this run: the existing DeviceHub tool required a device-interaction skill unavailable in this environment.
At 1920×1080, the second Compact poster is at `(422.2, 236)`, size `223.6×335.4`, versus Apple's `(422, 236)`, `224×335`; the count starts at `(128, 162)` versus `(128, 161)`.
The focused artwork is `248.9×373.4` versus Apple's measured `250.7×375`; native parallax/specular lift is represented by the existing CSS scale/shadow equivalent.
Inter replaces SF Pro, so longer captions can truncate sooner even at the same font size.
Compact was measured in the Samsung simulator; Standard/Large geometry, reduced motion, delayed badge changes and failure/loading/empty states have automated browser coverage, without paired native frames for each state.

Both real Home and library section requests returned 200 with 60 initial cards and the exact 1,021-item total.
The [retained-depth capture](screenshots/117-section/section-depth.png) records a successful 60→120-card append and Details/Back return: the same focused card at `y=633.6`, scroll `3872`, with no catalog query during that round trip.
The existing scroll owner restarts a reveal only when a section repaint restores the focused card outside its 12px/32px viewport margins.
The locked-desktop session used CDP focus emulation in Samsung's software simulator; this does not establish native visibility handling, Tizen 8 hardware behavior, browser-origin compatibility or successful AVPlay playback.
Physical-TV runs remain deferred until simulator parity is complete.

The signed WGT SHA-256 is `81dbbd519e1dfd8274439b66c36d4c06b1c18d6a321f000e00f20836e2c08c79`.
All 14 unpacked files matched the installed simulator files; their complete hashes are in [the installed asset manifest](screenshots/117-section/installed-calibrated.sha256), SHA-256 `5e910bc2141ad8d298c2acc14be603fb18deaad096d9b3c998fa805f8d2c09a5`.

Search capabilities control the Genres, A–Z and Recently Added destinations.
Explicit unsupported capabilities leave Browse and Collections available; failed reads show an error and Retry.
A–Z and Recently Added grids have no marquee; the alphabet rail is on the right and supports remote entry and return.
All requests use the existing operations/session/NativeHttp owners and active profile authority.
Changing mode, scope or sort starts a fresh page sequence; Back restores the previous collection, section or genre focus.
Each library mode remembers its own committed card and scroll position under the shared public view id.
Loading and failed initial reads do not replace a saved visit with placeholder controls.
Back from Details, playback or Settings keeps the saved position when its card still intersects the viewport and fits horizontally inside its shelf.
A partly clipped shelf card is revealed, while a missing or offscreen shelf card uses the visible fallback.
Grid cards retain their identity and are revealed when offscreen.
Reduced motion leaves focused cards at their resting size.
Return visibility is measured before reveal, including when reduced motion applies scrolling immediately.
Entering library content from navigation does not restore a saved navigation or selector control as the default card.

The approved Skyline guide was read from the historical export in `issue-27-browse-shell-20261030/skyline-design-guide.md` because this iMac has no sibling `silo-apple` checkout.
The source and seven API fixtures are pinned to server commit `cc8514943289045e7b9f7ac8d36d4968bfe93926`.
Optional test screenshots require both `DISCOVERY_CAPTURE` and `DISCOVERY_OUTPUT`; ordinary tests create no evidence directory.
Desktop fake-server tests exercise discovery, authentication authority and the existing detail/player handoff.
They do not establish Samsung simulator, actual Chromium 76, packaged Tizen or physical TV compatibility.
Home and whole-app parity remain outside this slice, and issue 28 remains open for parent review and remaining acceptance.
