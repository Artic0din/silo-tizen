# Title ratings

The native schema is pinned by `src/contracts/v2/SOURCE` to `cc8514943289045e7b9f7ac8d36d4968bfe93926`.
Its `contracts/api/v2/openapi.json` defines profile-scoped GET, PUT and DELETE `/api/v2/ratings/{item_id}`.
GET returns `RatingEntry` or 404 for an unrated title.
PUT accepts `RatingSet`: integer `rating` from 1 to 5 stars; PUT and DELETE return 204 and are `non_retryable`.
All requests use the existing session's profile identity and PIN proof.
Writes disable refresh replay and transport retries, and a readback confirms success.
An explicit Retry reads first to reconcile a lost response before sending a write.

The Apple reference was inspected at `Silo-Server/silo-apple` revision `1a7cceeaf3b2bfc4f889c00487d19b2c6f843940`.
`iosApp/iosApp/tvOS/Screens/Detail/TVItemDetailView.swift` displays external ratings through the catalog projection.
That revision has no personal `/ratings` calls or personal star-entry control to port.
Tizen therefore uses the native schema and explicit remote-focusable 1–5 star and Clear rating buttons on movie and series pages.

Automated tests exercise a synthetic server and desktop Chromium.
They do not establish live-server or Samsung hardware acceptance.
