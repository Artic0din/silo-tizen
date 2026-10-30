# Person filmography

Person retains its metadata and a 24-title preview.
See all pushes a Filmography grid with All, Movies and Series filters.
All explicitly requests `video` (movies and series), and filters apply to the whole server population before paging.
The preview uses the verified GET `sort=-year`; full pages use the existing safe POST query with `sort: "year"`, `order: "desc"` and `limit: 24`.
Their opaque continuations belong to different operation scopes and are never shared.
There is no person capability probe or focus-triggered request.

Previous and Next replace the visible page; only that page's cards and cursor history are retained.
Page, index and continuation history commit together after a valid response.
A failed turn retains the visible page and its requested target for explicit Try again.
A missing or empty continuation when `has_more` is true is a protocol error at the shared catalog decoder; bounded collections can still omit `page`.
A continuation repeating this route's earlier page cursors is a recoverable protocol error before committing the response.
An `invalid_cursor` discards only the current route's paging state; explicit Try again starts page one without an automatic loop.

Cards use the existing title Details, seasons, episodes and file/resume handoff.
Opening Details abandons an in-flight page target.
Back refreshes the committed page while retaining cached cards, restoring focus by content ID with a nearby fallback if that ID disappeared.
Person metadata survives filters, paging and playback refresh; Back restores See all and then the originating credit.
The existing FocusHost owns horizontal rail and vertical viewport restoration.
The existing session owns all profile, PIN, refresh, replay and cancellation rules.
The client does not deduplicate names, filter server access decisions or project jobs and characters into catalog cards.

Primary sources are canonical Apple commit `f33479404712737499b22365430db1885cf6c6ab` (the distinct tvOS Person view and person query factory), server commit `cc8514943289045e7b9f7ac8d36d4968bfe93926` (OpenAPI, handlers, parser, query definition, person membership and access resolver), and Skyline guide SHA-256 `2d42d292e01ab6ee539278b63c286756fc432edf876a9286a33c9e853672cac2`.
Apple loads more near the grid's end; Tizen deliberately requires an explicit page action to preserve the no-fetch-on-focus rule.
Server IDs remain strings; realistic person fixtures use a positive canonical integer string, and slash-containing IDs test escaping only.
An empty filtered membership result does not imply missing person metadata.

`personFilmography.ts` exports `personQuery` and `personFilmographyView`.
Shared additions are the `person` query source, optional `person_id`, `personFilmography` route, `RouteHandlers.personFilter`, and the Person view's See all callback.
No new fetch, router, cache, auth or player owner is introduced.

This bounded journey does not complete Person parity or issue 28.
Metadata enrichment dispatch/polling, age, initials and thumbhash parity remain separate work.
No explicit RefreshPerson POST is sent automatically.
Synthetic desktop tests and captures do not prove a live backend, Chromium 76 runtime, AVPlay, signed WGT, emulator or real TV.
