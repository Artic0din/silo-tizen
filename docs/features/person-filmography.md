# Person filmography

Person retains its hero and metadata above a title count, All/Movies/Series chips and the existing paged grid.
The ready page has no Back, See all or Read synopsis buttons; remote Back returns directly to the originating credit.
The metadata failure state retains explicit Retry and Back.
All requests `video`, Movies requests `movie`, and Series requests `series` across the whole server population before paging.
Every page uses `personQuery`: a safe POST with an opaque string person ID, `sort: "year"`, `order: "desc"`, `limit: 24` and opaque continuations.
The Person page no longer uses GET preview continuations or a separate Filmography route.
No names are deduplicated and no extra media types are introduced.

The count uses the server total, with `About` when `totalExact` is false and singular `title` for one.
All three chips remain usable, including empty and failed filters; no availability probes are required to enter a filter.
Metadata loads once per Person visit and survives filter changes, paging, failed reads, cursor recovery, Details and playback return.
A first works failure retains the hero and filter controls.

Previous and Next replace the visible page; only that page's cards and cursor history are retained.
Page, index and continuation history commit together after a valid response.
A failed turn retains the visible page and its requested target for explicit Try again.
A missing, empty or repeated continuation is a recoverable protocol error.
An `invalid_cursor` discards only paging state; explicit Try again starts page one without an automatic loop.
Opening Details or CardActions abandons an in-flight page target.
CardActions changes refresh the committed page with the same person, filter and cursor.
Details Back restores the same Person card, filter, page and viewport, with nearby identity fallback when a card disappeared.
The existing FocusHost owns viewport restoration and modal isolation; the session owns authority teardown and cancellation.
Moving focus never fetches.

Person uses Apple's source constants: horizontal 80, top 48, hero-to-filmography 48, section 28, heading-to-chips 20 and bottom 72 px.
The heading is 36 px semibold; the count and chips are 22 px regular.
Chips have 22/10 px horizontal/vertical padding, 8 px gaps and 8 px vertical bar padding; focus scales them to 1.06 over 120 ms.
The selected chip uses the surface-variant colour, with a light outline on focus.
The existing catalog card styles provide 260×390 artwork, 40/60 px column/row gaps and the existing focus lift and reduced-motion treatment.
The existing poster-size preference selects six or five columns; the focus zone uses the same column count.
These constants are source-derived, not native comparison evidence or acceptance of the historical 72 px offset.
The [hero](person-hero.md) preserves portrait, ThumbHash, Unicode, age, image fallback, reduced motion and late-event handling.
Dates retain the device region.

Apple source was read from a read-only clone at `9723df007baa8e933f5615cc14b13e99a6ee1ea1`; this does not identify the installed Apple build.
Source paths below are relative to `iosApp/iosApp/` at that commit.

| Area | Apple source | Tizen adaptation |
| --- | --- | --- |
| Screen spacing | `Screens/People/PersonDetailView.swift:401–440`, `Theme/SiloTheme.swift:108` | Person-only padding and section margins |
| Hero | `Screens/People/PersonDetailView.swift:445–487` | Existing Person hero, 300×450 portrait, 48 gap, 72 title, 22 stack spacing, 10 top inset, 26 biography capped at seven lines and 920 width; 20 px capsules with 16/8 padding and 12 gap |
| Missing photo | `Screens/People/PersonDetailView.swift:688–716` | Existing initials at 84 px, elevated background, 12 radius, 1 px white 10% border; retained ThumbHash/load/error/cancellation owner |
| Count and filters | `Screens/People/PersonDetailView.swift:490–509`, `:765–847`, `Theme/Typography.swift:15–39` | Server count, All/Movies/Series, 36 heading, 22 count/chips; all filters remain reachable without availability probes |
| Grid and paging | `tvOS/Screens/Components/TVCatalogGrid.swift:21–39`, `Theme/SiloTheme.swift:126` | Existing cards and grid; explicit Previous/Next instead of near-end loading, 24 items per page instead of Apple's 60 |
| Dates | `Screens/People/PersonDetailView.swift:896–930` | Local Gregorian components and medium date using the device region; Australian region gives `28 Nov 1994` |
| States | `Screens/People/PersonDetailView.swift:354–363`, `:409–421` | Existing status/Retry/Back before metadata; retained hero/chips with Loading, error/Retry or empty filmography afterward |

The inherited server query contract reference is `cc8514943289045e7b9f7ac8d36d4968bfe93926`, and the Android Person detail design reference is `6f3e36820e573cd63d73f200fb2beb160ff09f85`.
Tizen uses explicit page actions to preserve no-fetch-on-focus, rather than Apple's near-end loading.
There is no new fetch, router, cache, auth or player owner, and no metadata refresh dispatch or polling.

Desktop tests prove synthetic behavior only.
Signed WGT, native layout calibration, matched Apple TV evidence, AVPlay and physical-TV acceptance remain parent validation gates.
This source change does not establish whole-feature parity or close the discovery umbrella.

## Remote trace and native capture handoff

Use the same server, profile, Australian region, poster-size preference and title/credit on both clients; record each installed build and actual capture dimensions.
Do not assume the Apple installation matches the source revision above.

1. Open a movie's Details, move Down to its cast, focus a named credit and select it.
   Capture Person with its photo, metadata, count and All selected; repeat with a person whose photo is absent to capture initials.
   Also capture a failed photo and a long biography after the image has settled.
2. On Samsung, initial loading focuses All; the first filmography response must leave that chip focused without any input.
   Left at All and Up at the chip row stay there; Right moves All → Movies → Series, and Left reverses that path.
   Enter applies the filter and preserves chip focus through loading, success, empty and failure.
   On Apple, use the remote to focus and select the same chips; record the native focus landing rather than assuming it.
3. Press Down from the chips to the grid, move Left/Right across a row and Up/Down between rows, and test all four outer edges and the partial final row.
   On Samsung, Up from the first row returns to the remembered chip; Left/Right at row edges stay on that card, Down from the last row reaches the pager, and Up returns to the remembered card.
   Capture the same first-row card focused on both clients, then scroll to a later shared title.
   Samsung uses Next page/Previous page with Enter; Apple loads near the end of the grid.
4. Select that title, then press Back once: capture the restored Person card and viewport.
   Press Back again: capture the original Details credit focused.
   Record the journey for focus and timing comparison.
5. With a controlled read-only test server or network interception, hold the metadata read, then the first credits read; capture loading before and after the hero exists.
   Return an error for each read and exercise Retry, then an empty credits response and an empty filter.
   Hold a later page response, open a visible title, return and release the old response; the abandoned page must not replace the committed page.
   Capture a network failure separately; do not edit live catalog data to create these states.

Known differences retained by this scope: explicit paging and status copy, visible empty filters, sequential metadata/credits reads, Samsung One instead of SF Pro, and no Apple metadata refresh dispatch/polling.
Native focus geometry, motion, image-failure rendering and these state differences remain for the parent's comparison; desktop tests cannot establish their visual equivalence.
