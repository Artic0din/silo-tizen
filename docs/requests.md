# Requests

Requests appears in the browse navigation only after `/api/v2/requests/status` reports `requests_enabled`, `allowed` and `state=available`.
Unknown or failed initial probes leave the root hidden.
A transient later probe failure preserves the last confirmed value.
Status is checked on foreground return and before loading each Requests route.
Capability and permission refusals trigger another status check; a confirmed unavailable feature removes its retained root and returns open Requests journeys to Home.

The hub displays the server's ordered discovery title rows, with paged row browsing, title search and My Requests.
Unknown discovery row types are skipped.
Media detail uses server requestability, status and follow decisions.
Request detail shows the server state and offers cancellation for the active profile's pending request.
Series creation omits `seasons`, requesting all aired seasons still missing, as defined by the native contract.
Administration stays in web admin.

All operations pass through the native adapter and `session.call` with active profile authority.
Create, cancel, follow and unfollow never replay after a transport failure or session refresh.
After an unconfirmed write, Refresh reads authoritative state before enabling another write.
Back remains available during work; writes retain their session ownership and a profile change tears down the UI and fences late answers.
The existing browse stack and focus host restore the originating item by stable key.
Focus movement performs no reads or writes.
Search runs on Search or keyboard Done; editing cancels obsolete reads immediately.

## Contract references

- Native OpenAPI: `contracts/api/v2/openapi.json` at [`cc8514943289045e7b9f7ac8d36d4968bfe93926`](https://github.com/Silo-Server/silo-server/blob/cc8514943289045e7b9f7ac8d36d4968bfe93926/contracts/api/v2/openapi.json), the revision pinned by `src/contracts/v2/SOURCE`.
- Apple [`TVRequestsPage`](https://github.com/Silo-Server/silo-apple/blob/1a7cceeaf3b2bfc4f889c00487d19b2c6f843940/iosApp/iosApp/tvOS/Screens/Requests/TVRequestsPage.swift) supplies the hub/mine and return-focus reference.
- Apple [`RequestsFeatureStore`](https://github.com/Silo-Server/silo-apple/blob/1a7cceeaf3b2bfc4f889c00487d19b2c6f843940/iosApp/iosApp/Networking/RequestsFeatureStore.swift) supplies the capability re-probe and transient-failure reference.

## Validation and evidence

`npm test` runs the production build, strict typechecking, native contracts and desktop Chromium journeys.
There is no lint command in package.json or CI.
Run `REQUESTS_EVIDENCE=artifacts/requests node --test --test-timeout=60000 test/ui/requests.test.ts` to capture matched Home, hub, search, detail, My Requests, empty, failure and loading screenshots from that same test run.
Artifacts are intentionally ignored by Git.
The harness bundles for Chrome 76 but runs desktop Chromium against a fake native server; it does not establish real-server deployment, Tizen software-emulator or Samsung TV acceptance.
Signed packaging requires the Tizen CLI and a configured developer security profile via `scripts/build-wgt.sh`.
