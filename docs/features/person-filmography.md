# Person filmography

Person retains its hero and metadata above a title count, All/Movies/Series chips and the existing paged grid.
The ready page has no Back, See all or Read synopsis buttons; remote Back returns directly to the originating credit.
The metadata failure state retains explicit Retry and Back.
All requests `video`, Movies requests `movie`, and Series requests `series` across the whole server population before paging.
Every page uses `personQuery`: a safe POST with an opaque string person ID, `sort: "year"`, `order: "desc"`, `limit: 24` and opaque continuations.
The Person page no longer uses GET preview continuations or a separate Filmography route.
No names are deduplicated and no extra media types are introduced.

The count uses the server total, with `About` when `totalExact` is false and singular `title` for one.
Movies and Series are hidden only when a profile-scoped server query with `limit: 1` returns no items and a zero total.
Failed availability probes keep the chip visible, as Apple does; the first page never decides availability.
Metadata loads once per Person visit and survives filter changes, paging, failed reads, cursor recovery, Details and playback return.
Metadata, credits and availability reads start independently through the existing session transport.
Metadata and availability share a visit signal, cancelled when that visit leaves; credits keep the replaceable page-request signal.
Changing page or filter while metadata is pending does not restart it, and metadata cannot keep completed credits busy.
The hero shell uses the originating credit's name and initials until metadata arrives, with a Loading metadata capsule; credits can already be visible and usable.
Metadata failure retains the loaded credits, explicit Retry and Back.
A first works failure retains the hero and filter controls.

Previous and Next replace the visible page; only that page's cards and cursor history are retained.
Page, index and continuation history commit together after a valid response.
A failed turn retains the visible page and its requested target for explicit Try again.
A missing, empty or repeated continuation is a recoverable protocol error.
An `invalid_cursor` discards only paging state; explicit Try again starts page one without an automatic loop.
Opening Details or CardActions abandons an in-flight page target.
CardActions changes refresh the committed page with the same person, filter and cursor.
Details Back restores the same Person card, filter, page and viewport, with nearby identity fallback when a card disappeared.
Opening Person again from a credit starts a fresh All visit; it does not restore the discarded visit's chip focus or scroll.
The existing FocusHost owns viewport restoration and modal isolation; the session owns authority teardown and cancellation.
Moving focus never fetches.

Person uses rendered insets of horizontal 160, top 108 and bottom 132 px: the Swift padding (80/48/72) plus tvOS's horizontal 80 and vertical 60 safe area.
The signed comparison supplied the safe-area contribution; those extra insets are not literals in `PersonDetailView.swift`.
Hero-to-filmography remains 48, section 28 and heading-to-chips 20.
The heading is 36 px semibold and the count is 22 px regular in secondary text (`#EDEDED` at 60%).
The title/count gap is 60 px from the signed comparison; Swift's HStack has no explicit spacing literal.
Chips use 22 px regular text, 22/10 px padding, 8 px gaps, 8 px bar padding and a capsule.
Resting fill is elevated at 55% with a 1 px white 8% stroke; selected fill is `#0E0F12` with a 1 px white 16% stroke.
Focus fills surface-variant at 80% unless the chip is selected, draws a 2 px `#EDEDED` at 85% stroke, and scales to 1.06 over 120 ms.
Biography explicitly uses 26 px regular (400), in the same 60% text colour, with 22 px between the name, facts and biography.
`Font.siloBody` is 26 pt regular; no smaller tvOS biography font is specified in the Swift reference.
Facts stay 20 px capsules with 16/8 px padding and a 12 px gap.
The grid clears the generic fixed width and padding and spans 1600 px, with six flexible cells, a 273.33 px pitch and a 60 px row gap.
Person cards add the 60 px vertical safe area to the existing 12/32 px focus reveal margins (72/92 px); the synthetic first-row reveal scrolls 237 px and chip focus restores zero.
Posters remain 260×390; the flexible cells use the same overlapping-card geometry as Apple's grid.
The existing catalog card styles supply the artwork, focus lift and reduced-motion treatment.
The existing poster-size preference selects six columns, or five when poster scale is above 1; the focus zone uses that count.
Source literals and measured native values are distinguished above; this correction still requires a new signed comparison.
The [hero](person-hero.md) preserves portrait, ThumbHash, Unicode, age, image fallback, reduced motion and late-event handling.
Dates retain the device region.

Apple source was read from a read-only clone at `9723df007baa8e933f5615cc14b13e99a6ee1ea1`; this does not identify the installed Apple build.
Source paths below are relative to `iosApp/iosApp/` at that commit.

| Area | Apple source | Tizen adaptation |
| --- | --- | --- |
| Screen spacing | `Screens/People/PersonDetailView.swift:401–440`, `Theme/SiloTheme.swift:108` | Person-only padding and section margins |
| Hero | `Screens/People/PersonDetailView.swift:445–487` | Existing Person hero: 300×450 portrait, 48 gap, 72 bold title, 22 between name, facts and biography, 10 top inset, 26 biography capped at seven lines and 920 wide; 20 px capsule text, 16/8 padding, 12 gap |
| Missing photo | `Screens/People/PersonDetailView.swift:688–716` | Existing initials at 84 px, elevated background, 12 radius, 1 px white 10% border; retained ThumbHash/load/error/cancellation owner |
| Count and filters | `Screens/People/PersonDetailView.swift:288–310`, `:490–509`, `:765–847`, `Theme/Typography.swift:15–39` | Server count and availability, 36 heading, 22 count/chips |
| Grid and paging | `Screens/People/PersonDetailView.swift:52`, `tvOS/Screens/Components/TVCatalogGrid.swift:21–39`, `Theme/SiloTheme.swift:126–128`, `Components/AdaptiveLayout.swift:46–57` | Existing catalog cards; explicit Previous/Next instead of near-end loading; 24 items per page instead of Apple's 60; six columns, five when the poster scale is above 1 |
| Dates | `Screens/People/PersonDetailView.swift:896–930` | Local Gregorian components and medium date using the device region; Australian region gives `28 Nov 1994` |
| States | `Screens/People/PersonDetailView.swift:88–116`, `:409–421`, `:484–486`, `:720–762` | Independent reads, hero shell and metadata capsule; error/Retry or empty filmography |
| Status ribbons | `tvOS/Screens/Components/TVCatalogGrid.swift:83`, `tvOS/Screens/Components/TVMediaCard.swift:214–215`, `Overlays/OverlayRegistry.swift:346–372` | All catalog cards use the shared configured overlay owner; show_status remains disabled by default and obeys administrator/profile preferences |
| Focus and scrolling | `tvOS/Screens/Components/TVCatalogGrid.swift:58–124`, `Screens/People/PersonDetailView.swift:400–441` | Row focus sections inside a ScrollView; Tizen uses aligned spatial zone entry, stays on a card without a chip above it, and reveals the full hero when chips regain focus |

The inherited server query contract reference is `cc8514943289045e7b9f7ac8d36d4968bfe93926`, and the Android Person detail design reference is `6f3e36820e573cd63d73f200fb2beb160ff09f85`.
Tizen uses explicit page actions to preserve no-fetch-on-focus, rather than Apple's near-end loading.
Person's `Pages` state only replaces a committed page and retains cursor history, so it cannot append safely as-is.
`catalogFeed.ts` already provides near-end observation, but wiring it here requires migrating Person to an accumulating snapshot with append/refresh cursor validation, bounded loading and cancellation, plus converting the page-replacement regressions to append/return assertions.
That state migration is deferred rather than adding another paging owner.
No Page 1 of 1 label is rendered.
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
   On Samsung, Up from the first row enters a chip only when the card's centre is below that chip; otherwise focus stays on the card.
   Returning to chips restores scroll to zero; Left/Right at row edges stay on that card, Down from the last row reaches the pager, and Up returns to the remembered card.
   Capture the same first-row card focused on both clients, then scroll to a later shared title.
   Samsung uses Next page/Previous page with Enter; Apple loads near the end of the grid.
4. Select that title, then press Back once: capture the restored Person card and viewport.
   Press Back again: capture the original Details credit focused.
   Record the journey for focus and timing comparison.
5. With a controlled read-only test server or network interception, hold the metadata read, then the first credits read; capture loading before and after the hero exists.
   Return an error for each read and exercise Retry, then an empty credits response and an empty filter.
   Hold a later page response, open a visible title, return and release the old response; the abandoned page must not replace the committed page.
   Capture a network failure separately; do not edit live catalog data to create these states.

Known differences retained by this scope: explicit paging and status copy, Samsung One instead of SF Pro, and no Apple metadata refresh dispatch or polling.
Apple's All filter omits `type` (`PersonDetailView.swift:19–21`); this page keeps `type: "video"`, which the existing tests lock as the whole video population.
Apple's loading, error and empty filmography frames use a 420 pt minimum height and the copy "No titles found"; this page keeps the existing Loading, Try again and "No available titles for this filter." text without that frame.
Swift does not specify a numeric focus-scroll offset; verify the resulting grid scroll distance in the next matched native capture rather than treating 240 px as a source constant.
Native focus geometry, motion, image-failure rendering and these differences remain for the parent's comparison; desktop tests cannot establish their visual equivalence.
