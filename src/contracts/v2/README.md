# Silo /api/v2 contract (vendored)

`SOURCE` holds the exact `silo-server` commit these files come from.
`fixtures/` holds only the response bodies this client consumes, copied unchanged from
`contracts/api/v2/fixtures/` at that commit.
`wire.ts` decodes only the members the client reads; unknown members are ignored and unknown
response enum values decode to `"unknown"`, so additive server changes keep working.

## Operations used

| Operation | Retry class (`x-silo-retry-safety`) | Client behavior |
| --- | --- | --- |
| `getSystemInfo`, `getServerIdentity`, `getDeviceLoginCapability`, `listProfiles` | read | One transport retry after no answer or 502/503/504 |
| `startDeviceLogin` | `non_retryable` | Never resent; the person asks for a new code |
| `pollDeviceLogin` | `non_retryable` | Never resent; the next scheduled poll is a new request (`poll_after`) |
| `cancelDeviceLogin`, `logout` | `natural_idempotent` | One transport retry |
| `refreshSession` | `domain_identity` | Never resent; 401/400/422 end the session, others keep the tokens |
| `verifyProfilePIN` | `non_retryable` | Never resent, not even after a token refresh |

## Updating

1. Pick the new server commit and copy the same fixture names from its `contracts/api/v2/fixtures/`.
2. Write the commit SHA to `SOURCE`.
3. Re-read the OpenAPI schemas and docs for the operations above and update `wire.ts`.
4. Run the native tests.

## Native tests

Commands assume the repository root is the cwd.
Node 23.6 or later runs the TypeScript sources directly:

```bash
node --test --test-timeout=15000 test/native/
```

Type checking needs `allowImportingTsExtensions` (sources import `./x.ts`) and
`erasableSyntaxOnly` (Node strips types; no enums, namespaces or parameter properties).
