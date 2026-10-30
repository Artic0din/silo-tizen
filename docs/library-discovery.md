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
Catalog and collection pages contain at most 24 cards.
Section previews show at most 24 cards; their complete contents open through the section action.

Search capabilities control the Genres, A–Z and Recently Added destinations.
Explicit unsupported capabilities leave Browse and Collections available; failed reads show an error and Retry.
A–Z and Recently Added grids have no marquee; the alphabet rail is on the right and supports remote entry and return.
All requests use the existing operations/session/NativeHttp owners and active profile authority.
Changing mode, scope or sort starts a fresh page sequence; Back restores the previous collection, section or genre focus.

The approved Skyline guide was read from the historical export in `issue-27-browse-shell-20261030/skyline-design-guide.md` because this iMac has no sibling `silo-apple` checkout.
The source and seven API fixtures are pinned to server commit `cc8514943289045e7b9f7ac8d36d4968bfe93926`.
Optional test screenshots require both `DISCOVERY_CAPTURE` and `DISCOVERY_OUTPUT`; ordinary tests create no evidence directory.
Desktop fake-server tests exercise discovery, authentication authority and the existing detail/player handoff.
They do not establish Samsung simulator, actual Chromium 76, packaged Tizen or physical TV compatibility.
Home and whole-app parity remain outside this slice, and issue 28 remains open for parent review and remaining acceptance.
