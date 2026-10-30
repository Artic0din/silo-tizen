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
The profile avatar opens an anchored menu with Switch profile and Sign out.
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

The shell uses the shared tokens in `src/theme.css` alongside Skyline's navigation, marquee and card dimensions.
Desktop Chromium tests and synthetic captures do not prove actual Chromium 76, Tizen emulator, signed package or Samsung TV behavior.
