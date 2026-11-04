# Requests

Requests appears in the browse navigation only after `/api/v2/requests/status` reports `requests_enabled`, `allowed` and `state=available`.
Unknown or failed initial probes leave the root hidden.
A transient later probe failure preserves the last confirmed value.
Status is checked on foreground return and before loading each Requests route.
Capability and permission refusals trigger another status check; a confirmed unavailable feature removes its retained root and returns open Requests journeys to Home.

The hub reads My Requests in 50-record pages, with a 100-page bound and advancing cursors, alongside the server's ordered discovery title rows.
It groups active requests before attention states and landed titles, sorts newest first within each group, and omits unavailable or cancelled records.
Your requests appears first when nonempty, followed by Discover and horizontal discovery shelves.
The two reads answer together, as on Apple TV: either failing shows the error page while the hub has no rows, and a failed refresh silently keeps the rows already shown.
A discovery answer without `row_order` keeps the server's item order.
The passive hero previews the focused request using already loaded data; focus performs no API reads.
Its copy stays anchored above the row band as title and synopsis heights change.
A wrapped title reduces the synopsis to two lines; available provider ratings stay on the metadata line.
Two-line titles fill the first line as Apple TV does, never leave one word alone on the second, and keep the server's title text unchanged.
The shared topbar Search opens global Search and its independent Available to request rail.
A new bar-owned Search starts empty; Back returns to the selected Requests tab, and Down re-enters the content.
Back from a request detail retains the Search query and restores its result after an invalidated supplement refresh, unless the person moved focus or edited the query.
Search uses the existing state renderer for accessible progress, no-results copy and a centered catalog error with Try Again.
A failed People lookup leaves usable title results without another error panel or retry control; a new query tries People again.
A pending People lookup prevents premature No results but leaves catalog errors and Try Again visible.
Search title grids use five columns for large posters and six for standard or compact posters, including remote row navigation.
Your requests contains the complete bounded list; the ready hub has no separate Search requests, My Requests, Refresh or Back controls.
Discovery rows show only the first page the discover read returns, with no See all tile and no further read, because Apple TV's rails have neither.
Rows are view-aligned to the band's top at y=596: a plain row's heading is at 596 with art at 662, and the row with the Discover eyebrow has the eyebrow at 596, heading at 621 and art at 687.
Up and Down between rows land on the card nearest the focused card's centre, as Apple's focus engine does.
Each hub read goes out once; Try Again is the retry.
Selecting the Requests tab from another tab rebuilds the page: loading, a fresh read, then focus on the first card.
Selecting it again while shown moves focus to the first card and scrolls the band to the top without a read or a loading page, as on Apple TV.
A hub with no rows shows one of Apple's three full pages: the loading skeleton, ErrorView with status-aware copy and Try Again (Sign In Again first for a 401), or Nothing here yet.
The loading and empty pages hold focus with no highlight, and Try Again takes focus on entry and returns to the loading page.
Up from any of them, or from the first row, reaches the Requests tab; Down from the top bar returns to the page or the first card of the first row.
Unknown discovery row types are skipped.
Media detail uses server requestability, status and follow decisions.
Request detail shows the server state and offers cancellation for the active profile's pending request.
The primary action is one focusable pill that morphs in place, so focus stays on it through a write and the read that settles it.
Request shows a small spinner and Requesting… in the secondary pill style, and presses are ignored until the read answers.
Cancel disappears while it runs, and focus rests on the status pill beside it.
A failed detail read with nothing to show is Apple's ErrorView, using the hub's error page with Try Again focused.
A 403 or 404 offers Go Back first, a 401 offers Sign In Again first, and otherwise Back is the remote's.
Up and Down do nothing on that page because a pushed detail has no top bar.
Apple keeps a provisional page built from the tapped card or record when a first read fails; this client has no provisional page, so it shows the error page for every first-read failure.
Series creation omits `seasons`, requesting all aired seasons still missing, as defined by the native contract.
Administration stays in web admin.

Discovery rows, request search and My Requests show the contract's optional `poster_path`.
Hub previews and both detail routes use the optional `backdrop_path`, retaining title copy when artwork is absent or fails.
The decoder retains `backdrop_path`, year and the verified title detail metadata and recommendations.
These are TMDB paths, not server-relative image URLs.
Posters use `https://image.tmdb.org/t/p/w342`, matching Apple's `RequestImageURL`; absolute HTTP(S) references still pass through the existing image admission rule, including refusing plain HTTP for an HTTPS server.
Images use the shared lazy-loading artwork helper with `no-referrer`, empty decorative alt text and a title placeholder for missing, rejected or failed images.
Each request button keeps its title/status accessible name and its request identity and action; no catalog identity or quick action is fabricated.
Only an In library display state with a nonempty server catalog identity opens catalog Details.
Processing and partly available titles retain their request destination, even when the server also supplies a catalog identity.
The hub uses 176×264 posters, a 40px gap, separate captions and a lifted focused image.
Detail recommendations use 220×330 posters scaled by the existing poster-size preference.
Reduced motion keeps a visible focus ring without artwork growth.
Global Search uses the shared request cards in a horizontal rail.
The legacy request-search and My Requests routes retain their existing grids.
Both details use a backdrop hero, metadata, synopsis, readable status and four-stage tracker, existing eligible actions and verified recommendations under More like this.
Request summaries retain the local requested date and quality targets; series metadata retains season count and the first two creator credits.
Request record detail reads the native title detail endpoint for metadata and related results; failure leaves the record and its controls usable with a Refresh notice.
A ready detail has no controls below More like this, so Down stays on the poster.
Refresh and Back appear only after a failure or an unconfirmed write whose read also failed, or when the page would otherwise have no focus target.
The shared Skyline backdrop owner supplies ambient artwork and tint sampling.
Details reuse its palette with the native uniform 42% base tint, accent and shadow washes, while root pages keep the diagonal tint.
Both use the shared artwork fade stops.
The hub also uses its 190 px top scrim to keep navigation legible over bright artwork.
Inter remains the approved platform font substitute.
Request captions use calibrated 27 px Inter so titles such as Street Fighter and Neuromancer fit the matching native poster width.
Hub status captions use calibrated -0.6 px tracking, which reproduces the native widths of Queued, Partly in library and Adding to library.
The Request pill has calibrated 270 and 370 px minimum widths because Inter sets the word narrower than Apple's font.
Details title text uses calibrated horizontal compression to approximate the licensed Apple compressed face.
This remains a font substitution, not an identical font.
Signed Samsung captures informed the scene geometry and exposed platform stylesheet and caption-layering corrections.
Acceptance of the final candidate remains pending.
Owner decision: a detail with a status strip matches Apple's clip rather than avoiding it.
The hero is 810 px tall (`TVDetailLayout.heroHeight` + 120), so the action follows the copy, is cut at y=810, and More like this starts at 810 with posters at 866.
Without a status strip the hero stays 690 px, the action stays whole and posters start at 746.
As on Apple, copy tall enough to push the action past the hero edge also hides it, for example a primary title on two lines in a status detail.
More like this draws only cards touching Apple's 100 to 1820 lazy-rail bounds, without limiting the list, so Right reaches every title.
Down from the action lands on the poster nearest its centre and scrolls the page to its end, with posters at y=569 at the 0.86 poster size, so the action stays cut at the moved hero edge.
Moving right stops the focused poster 80 px inside the rail's right bound, so the next poster shows.
The backdrop scrolls with the hero while the page tint stays.

## Accepted differences

The focused poster's sheen and edge are a static CSS approximation of tvOS's system `.card` focus highlight, measured against Apple's pair 02a.
tvOS moves that highlight as the remote's surface moves, and the web platform has no equivalent input, so the sheen stays still.
The design of the Series destination page belongs to #92.
A status detail whose copy is tall enough to pass the hero edge hides the action, as on Apple TV (decision: match Apple).

## Evidence and remaining gates

Native Apple captures and hierarchy geometry from a Device Hub simulator were inspected read-only; no private hierarchy or media is included here.
Later comparisons use original 1920×1080 Apple pixels exported read-only from the same simulator, without upscaling.
The installed Apple source SHA is unproven.
The pinned Apple source below is a historical behavioral reference, not provenance for the installed app.
Part of the parent TVRequestsPage and the RequestProgress, RequestDisplayState, RequestMediaCard and RequestsHubViewModel source was unavailable during implementation and was not recovered.
Exact visual parity is not accepted: the final package still needs signed Apple/Samsung comparison and keyboard verification.
The paint corrections have bounded source and signed Samsung runtime proof, which does not establish whole-feature acceptance.
The Apple Requests detail source deliberately uses split title text rather than a title logo.
No live backend mutations were used for candidate proof.

All operations pass through the native adapter and `session.call` with active profile authority.
Create, cancel, follow and unfollow never replay after a transport failure or session refresh.
A failed write follows Apple's `RequestMutationFailure`: a server answer is definite, shows its message beside the action and allows another try.
Anything else may have landed, so the action is held and read back automatically; the message appears only if that read also fails, and Refresh is then the way to read again.
Back remains available during work; writes retain their session ownership and a profile change tears down the UI and fences late answers.
The existing browse stack and focus host restore the originating item by stable key.
Focus movement performs no reads or writes.
Search runs on Search or keyboard Done; editing cancels obsolete reads immediately.

## Contract references

- Native OpenAPI: `contracts/api/v2/openapi.json` at [`cc8514943289045e7b9f7ac8d36d4968bfe93926`](https://github.com/Silo-Server/silo-server/blob/cc8514943289045e7b9f7ac8d36d4968bfe93926/contracts/api/v2/openapi.json), the revision pinned by `src/contracts/v2/SOURCE`.
- Apple [`TVRequestsPage`](https://github.com/Silo-Server/silo-apple/blob/1a7cceeaf3b2bfc4f889c00487d19b2c6f843940/iosApp/iosApp/tvOS/Screens/Requests/TVRequestsPage.swift) supplies the hub/mine and return-focus reference.
- Apple [`RequestsFeatureStore`](https://github.com/Silo-Server/silo-apple/blob/1a7cceeaf3b2bfc4f889c00487d19b2c6f843940/iosApp/iosApp/Networking/RequestsFeatureStore.swift) supplies the capability re-probe and transient-failure reference.
- Apple [`RequestImageURL`](https://github.com/Silo-Server/silo-apple/blob/1a7cceeaf3b2bfc4f889c00487d19b2c6f843940/iosApp/iosApp/Screens/Requests/Core/RequestImageURL.swift) and [`RequestMediaCard`](https://github.com/Silo-Server/silo-apple/blob/1a7cceeaf3b2bfc4f889c00487d19b2c6f843940/iosApp/iosApp/Screens/Requests/Components/RequestMediaCard.swift) define direct TMDB poster resolution and request-specific poster cards.

## Validation and evidence

`npm test` runs the production build, strict typechecking, native contracts and desktop Chromium journeys.
There is no lint command in package.json or CI.
Run `REQUESTS_EVIDENCE=artifacts/requests node --test --test-timeout=60000 test/ui/requests.test.ts` to capture matched Home, hub, search, detail, My Requests, empty, failure and loading screenshots from that same test run.
Artifacts are intentionally ignored by Git.
The harness bundles for Chrome 108 but runs desktop Chromium against a fake native server; it does not establish real-server deployment, Tizen software-emulator or Samsung TV acceptance.
Signed packaging requires the Tizen CLI and a configured developer security profile via `scripts/build-wgt.sh`.
For native artwork acceptance, capture matched discovery, search, My Requests and detail states, including missing and failed posters.
Check caption readability, focus rings, Back restoration, scrolling and image loading without leaking the server address or authorization to the CDN.
