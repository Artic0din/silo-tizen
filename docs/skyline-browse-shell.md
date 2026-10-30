# Skyline browse shell

This slice applies the [Skyline guide](https://github.com/Silo-Server/silo-apple/blob/main/docs/skyline-design-guide.md) to the native browse owner.
Home, Movies, Series, Search and Profiles share mounted root navigation.
Only visible video library types appear, and mixed libraries can be scoped to either video type.
Detail, season and playback routes remove the root chrome.
Browse is the only implemented library destination; the remaining section destinations belong to issue #28.

Focus never activates a route or starts a request.
A library tab opens its anchored selector after 250 ms.
Down enters the selector, Right enters its Browse flyout, Left returns, and Back closes without committing.
Explicit activation commits one library, never a merged scope.
The profile avatar opens an anchored menu with Switch profile, personal lists, Settings and Sign out.
Back dismisses either anchored menu until focus leaves its anchor or the viewer presses it again.

`BrowseOptions.publicStorage` accepts the existing `PublicStorage` interface.
The composition owner passes its existing public storage dependency to persist scopes across launches.
`ConnectedServer` does not expose that dependency.
Without it, the choice lasts for the mounted browse session.
Storage failures also retain a session choice.
Keys contain server identity, profile identity and video type, and stored choices must match a currently visible library.
Credentials are never stored here.

Marquee fields come from `CatalogItem` at the pinned `src/contracts/v2/SOURCE` revision.
Backdrop, overview, runtime, duration and resume position are optional.
Missing metadata stays absent; the client does not request details on focus or invent badges.
Continue Watching keeps landscape geometry, using its backdrop or cropping its poster when no backdrop is available.
Progress appears only when the server supplies position and duration.
The first card previews immediately; subsequent previews wait 150 ms and crossfade for 240 ms.
Root transitions take 200 ms, and reduced motion snaps transitions and scrolling.
The noninteractive outgoing layer keeps its CSS classes and scroll position without serializing computed styles for each card.
The synopsis dialog exposes the complete detail overview with remote scrolling and restores focus on close.
Optional Details responses retain the active synopsis and its focus; closing shows the latest data, and route or profile teardown removes the dialog.

Pushed Details pages show optional title artwork, server-ordered ratings, facts and credits from the pinned v2 contract.
Cast and crew share a rail of at most 24 people, combining roles for the same server person ID.
Credits without a person ID remain readable without an invented person route.
Person pages show the biography and the first 24 accessible movie and series credits; related titles use a separate bounded rail with loading, empty and retry states.
These bounded rails do not implement Apple's complete paged person browser.
The reference for this slice is canonical [silo-apple at 148d5d7](https://github.com/Silo-Server/silo-apple/tree/148d5d70f8b8ce982a827fead2b16f8de40f0f57), subject to the binding Skyline guide.

Version selection carries the exact file ID to playback and uses that file's duration for the five-second resume end margin.
Watchlist and favorite controls require the personal-list capability and successful item membership reads.
The pinned server accepts movie, series and episode list membership; season list membership returns not found, so season pages retain watched actions only.
Writes are profile-scoped, never automatically retried or replayed after account refresh, and must be confirmed by a read.
An explicit retry reconciles the server's state before sending another write, including when the first answer was lost.
Watched controls use the authoritative `user_state.played` flag independently of optional `user_data` progress, falling back to the progress flag when no viewer flags are supplied.
Unknown watched state cannot confirm a write.
Aggregate watched changes reread visible episode rows and invalidate covered season data, including when a write answer is lost or cancelled.
If an episode reread fails, the existing rows remain with an explicit retry that reconciles state before another write.
Season metadata uses its real catalog ID; missing metadata leaves the episode list usable.
Facts remain individually reachable by remote, including lists taller than the screen.

Remote trailer metadata contains a site and site key, not an AVPlay stream URL.
A Samsung trailer handoff remains unverified, so this slice exposes no trailer control.
Apple's local extras, artwork preferences, automatic version quality ranking and complete person filters remain outside this slice.

The shell uses the shared tokens in `src/theme.css` alongside Skyline's navigation, marquee and card dimensions.
Desktop Chromium tests and synthetic captures do not prove actual Chromium 76, Tizen emulator, signed package or Samsung TV behavior.

Settings edits profile defaults through the existing native session and HTTP owners.
General contains Hidden libraries; Playback contains the [saved profile defaults](playback-quality.md#saved-profile-defaults), including separate video seek intervals.
The category rail, control pane and pickers share `FocusHost`.
Category focus only previews loaded controls; requests and writes require explicit activation.
Back cancels a picker, returns from controls to the category rail, then returns to browse with avatar focus.
Loading, empty and failed states retain reachable Back and retry controls.

Discovery checks the settings API version, capability state, allowed flag, manifest revision and profile scope before exposing controls.
The consumed contract subset is pinned to server `cc8514943289045e7b9f7ac8d36d4968bfe93926` in the synthetic settings fixture.
Language suggestions come from the discovered server contract, filtered by their introduction revision; unfamiliar valid stored tags remain selectable.
Original language uses `x-silo-original` from revision 9.
Automatic playback starts already omit explicit audio ID and index, allowing the server to consume the preference.
No quality-default or subtitle-default controls are exposed in this slice.

Profile rows and effective values are read separately and never copied into one another.
`No preference` stores explicit JSON null; `Use inherited default` deletes only the profile row.
A device, library or series audio override can continue to take priority.
The current effective value, source and policy constraints are shown separately from the edited profile value.
Writes are serialized, not automatically replayed, and confirmed by explicit and effective readback.
After an uncertain answer, retry first reconciles the exact profile scope; Retry-After blocks early requests.
Account/profile authority changes cancel work and clear old settings data.

The hidden-library editor requests `include_hidden=true`; access restrictions remain server-owned.
Library IDs stay opaque strings until the validated positive JSON-integer write boundary.
Each toggle rereads the profile list and preserves IDs absent from the editable library list.
Returning after a hidden-list mutation refreshes Home and root navigation and drops cached library roots.
The whole-array API remains last-write-wins across clients; rereading does not make concurrent edits atomic.
