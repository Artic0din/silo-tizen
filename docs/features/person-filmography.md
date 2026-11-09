# Person filmography

Person retains its hero and metadata above a title count, All/Movies/Series chips and the existing accumulating catalog feed grid.
The ready page has no Back, See all or Read synopsis buttons; remote Back returns directly to the originating credit.
The metadata failure state retains explicit Retry and Back.
All requests `video`, Movies requests `movie`, and Series requests `series` across the whole server population before paging.
Every page uses `personQuery`: a safe POST with an opaque string person ID, `sort: "year"`, `order: "desc"`, `limit: 60` and opaque continuations.
The Person page no longer uses GET preview continuations or a separate Filmography route.
No names are deduplicated and no extra media types are introduced.

The count uses the server total, with `About` when `totalExact` is false and singular `title` for one.
Movies and Series are hidden only when a profile-scoped server query with `limit: 1` returns no items and a zero total.
Failed availability probes keep the chip visible, as Apple does; the first page never decides availability.
The initial metadata read survives filter changes, paging, failed reads, cursor recovery, Details and playback return.
If trimmed biography, photo URL or birth date is missing, Person dispatches one non-replayed `POST /catalog/people/{id}/refresh` per visit and shows Loading metadata.
The queued receipt must identify this person.
Polling reads the person every 3 seconds for up to 120 seconds, stopping after five consecutive unchanged answers or complete metadata.
Changes to any decoded Person field reset the unchanged count; failed polls leave the current metadata usable.
Dispatch rejection stops polling except for 2xx/malformed receipts, 429, server errors other than 503, or an uncertain network outcome.
Leaving cancels polling; returning to an unfinished visit resumes without another dispatch, while an exhausted visit stays stopped.
Metadata, credits and availability reads start independently through the existing session transport.
Metadata and availability share a visit signal, cancelled when that visit leaves; credits keep the replaceable page-request signal.
Changing page or filter while metadata is pending does not restart it, and metadata cannot keep completed credits busy.
The hero shell uses the originating credit's name and initials until metadata arrives, with a Loading metadata capsule; credits can already be visible and usable.
Metadata failure retains the loaded credits, explicit Retry and Back.
A first works failure retains the hero and filter controls.

Previous, Next and page labels are removed.
The existing `feedGrid` observes the last eight rows: 48 cards at six columns, 40 at five columns.
When those cards appear while scrolling, one more 60-title page loads; an in-flight guard prevents overlapping page reads.
Cards append in place, and loaded items and continuation history commit together after a valid response.
A failed later page retains its cards without an error panel, matching Apple's nonempty-grid branch.
There is no timed page retry; scrolling away from the near-end area and back can request the continuation again.
A missing, empty or repeated continuation is a recoverable protocol error.
An `invalid_cursor` on a continuation reads a fresh first page once, replacing the old list as Apple's catalog continuation helper does.
Opening Details or CardActions abandons an in-flight page target.
CardActions changes and Details return refresh from page one through the committed loaded depth with the same person and filter.
Details Back restores the same Person card, filter and viewport, with nearby identity fallback when a card disappeared.
Opening Person again from a credit starts a fresh All visit; it does not restore the discarded visit's chip focus or scroll.
The existing FocusHost owns viewport restoration and modal isolation; the session owns authority teardown and cancellation.
Moving focus away from the near-end trigger never fetches.
Focus handlers themselves do not read; scrolling can reveal the near-end trigger.

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
Person cards retain their existing focus reveal margins (72/132 px); the synthetic first-row reveal scrolls 277 px and chip focus restores zero.
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
| Grid geometry | `tvOS/Screens/Components/TVCatalogGrid.swift:21–39`, `Theme/SiloTheme.swift:126–128`, `Components/AdaptiveLayout.swift:46–57` | Existing catalog cards; six columns, five when the poster scale is above 1 |
| Dates | `Screens/People/PersonDetailView.swift:896–930` | Local Gregorian components and medium date using the device region; Australian region gives `28 Nov 1994` |
| States | `Screens/People/PersonDetailView.swift:88–116`, `:409–421`, `:484–486`, `:720–762` | Independent reads, hero shell and metadata capsule; error/Retry or empty filmography |
| Status ribbons | `tvOS/Screens/Components/TVCatalogGrid.swift:83`, `tvOS/Screens/Components/TVMediaCard.swift:214–215`, `Overlays/OverlayRegistry.swift:346–372` | All catalog cards use the shared configured overlay owner; show_status remains disabled by default and obeys administrator/profile preferences |
| Focus and scrolling | `tvOS/Screens/Components/TVCatalogGrid.swift:58–124`, `Screens/People/PersonDetailView.swift:400–441` | Row focus sections inside a ScrollView; Tizen's aligned move lands on the chip closest to the card's left edge, stays when no chip meets the card, and reveals the full hero when chips regain focus |

The inherited server query contract reference is `cc8514943289045e7b9f7ac8d36d4968bfe93926`, and the Android Person detail design reference is `6f3e36820e573cd63d73f200fb2beb160ff09f85`.
Paging and refresh were subsequently traced with `gh api` at Apple main `7baff3ef657757cc0a69202e86dd4bd5c7fcb585`.
The view model and root lifecycle are outside platform guards, and the tvOS content explicitly consumes both paging and refresh state.
Paths in the following table are relative to `iosApp/iosApp/` at that exact SHA.

| Behavior | Apple source |
| --- | --- |
| Page size 60, guarded append, continuation and errors | `Screens/People/PersonDetailView.swift:52`, `:129–132`, `:256–285` |
| tvOS route, blank first-load frame, error/empty frame at 420, nonempty grid and near-end callback | `Screens/People/PersonDetailView.swift:368–377`, `:392–440` |
| Eight rows times resolved columns; default six columns; spinner during later loading | `tvOS/Screens/Components/TVCatalogGrid.swift:21`, `:41–51`, `:123–143` |
| Stable item focus identity, row focus sections; explicit first-item focus request only when requested | `tvOS/Screens/Components/TVCatalogGrid.swift:58–121`, `:166–171` (Person supplies no focus request) |
| Incomplete fields and metadata indicator | `Screens/People/PersonDetailView.swift:852–854`, `:484–486`, `:720–735` |
| Poll constants 120 seconds, 3 seconds, five unchanged answers; once-only dispatch and rejection policy | `Screens/People/PersonDetailView.swift:43–47`, `:145–254` |
| Start/resume and cancellation reachable on tvOS | `Screens/People/PersonDetailView.swift:69–82`, `:335–350` |
| Dispatch route, non-replay, 202 and queued person receipt | `Networking/APIv2/APIv2Client.swift:968–987`, `:1015–1032` |
| Invalid continuation restarts from a fresh first page | `Networking/SiloAPI.swift:258–274` |

Android TV at `670f5ba0ae2ed8065bb3d6a23c7317a09b5bc666` also uses 60-title works pages (`androidTvApp/src/androidMain/kotlin/org/siloserver/silo/tv/ui/screens/people/TvPersonDetailViewModel.kt:21`).
Existing native API operations support this change; no upstream changes are required.

Desktop tests prove synthetic behavior only.
Signed WGT, native layout calibration, matched Apple TV evidence, AVPlay and physical-TV acceptance remain parent validation gates.
This source change does not establish whole-feature parity or close the discovery umbrella.

## Remote trace and native capture handoff

Use the same server, profile, Australian region, poster-size preference and title/credit on both clients; record each installed build and actual capture dimensions.
Do not assume the Apple installation matches the source revision above.

1. Choose a person with more than 60 accessible titles, then open a movie's Details, move Down to its cast, focus that credit and select it.
   Capture Person with its photo, metadata, count and All selected; repeat with a person whose photo is absent to capture initials.
   Also capture a failed photo and a long biography after the image has settled.
2. On Samsung, initial loading focuses All; the first filmography response must leave that chip focused without any input.
   Left at All and Up at the chip row stay there; Right moves All → Movies → Series, and Left reverses that path.
   Enter applies the filter and preserves chip focus through loading, success, empty and failure.
   On Apple, use the remote to focus and select the same chips; record the native focus landing rather than assuming it.
3. Press Down from the chips to the grid, move Left/Right across a row and Up/Down between rows, and test all four outer edges and the partial final row.
   On Samsung, Up from the first row enters the chip closest to the card's left edge, and stays on the card when no chip meets it.
   Returning to chips restores scroll to zero; Left/Right at row edges stay on that card, and Down at an exhausted grid stays on a card.
   Capture the same first-row card focused on both clients, then scroll to a later shared title.
   Record both clients loading beyond the first 60 titles near the last eight rows, the loading spinner, preserved focused title and scroll position as the page appends, and the exhausted partial final row.
   Repeat with Large posters to check the five-column trigger.
4. Select that title, then press Back once: capture the restored Person card and viewport.
   Press Back again: capture the original Details credit focused.
   Record the journey for focus and timing comparison.
5. With a controlled read-only test server or network interception, hold the metadata read, then the first credits read; capture loading before and after the hero exists.
   Return an error for each read and exercise Retry, then an empty credits response and an empty filter.
   Hold a later page response, open a visible title, return and release the old response; the abandoned page must not replace the committed list.
   Capture a network failure separately; do not edit live catalog data to create these states.
   Capture incomplete metadata with Loading metadata, its refresh dispatch and bounded polling, a metadata update that preserves card focus, and cancellation on Back.

Known differences retained by this scope: Samsung One instead of SF Pro and the existing initial hero shell while metadata loads.
Apple's All filter omits `type` (`PersonDetailView.swift:19–21`); this page keeps `type: "video"`, which the existing tests lock as the whole video population.
Initial filmography loading reserves a clear 420 px frame; errors and empty states also reserve at least 420 px, and the empty state uses "No titles found" with Apple's subtitle.
Swift does not specify a numeric focus-scroll offset; verify the resulting grid scroll distance in the next matched native capture rather than treating 240 px as a source constant.
Native focus geometry, motion, image-failure rendering and these differences remain for the parent's comparison; desktop tests cannot establish their visual equivalence.
