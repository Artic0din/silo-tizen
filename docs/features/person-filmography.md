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

Person-only geometry starts from Apple horizontal 80, top 48, hero-to-filmography 48, section 28 and heading-to-chips 20 px.
Global browse and card geometry are unchanged.
These are source starting constants, not native calibration or acceptance of the historical 72 px offset.
The [hero](person-hero.md) preserves portrait, ThumbHash, Unicode, age, image fallback, reduced motion and late-event handling.
Dates retain the device region.

Sources: Apple `PersonDetailView.swift` at `1a7cceeaf3b2bfc4f889c00487d19b2c6f843940`, server native query contract at `cc8514943289045e7b9f7ac8d36d4968bfe93926`, and Android Person detail design at default-branch SHA `6f3e36820e573cd63d73f200fb2beb160ff09f85`.
Tizen uses explicit page actions to preserve no-fetch-on-focus, rather than Apple's near-end loading.
There is no new fetch, router, cache, auth or player owner, and no metadata refresh dispatch or polling.

Desktop tests prove synthetic behavior only.
Signed WGT, native layout calibration, matched Apple TV evidence, AVPlay and physical-TV acceptance remain parent validation gates.
This source change does not establish whole-feature parity or close the discovery umbrella.
