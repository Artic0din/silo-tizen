# TV launch profiles

TVs show Who's watching by default.
The first selection offers Remember this profile or Ask who's watching at launch.
General Settings can change that choice later.
Selecting another protected profile still requires its PIN.

This is device-local state, scoped to the server URL, server deployment identity, device identity and account.
The settings manifest at `src/contracts/v2/SOURCE` (`cc8514943289045e7b9f7ac8d36d4968bfe93926`) contains no profile-launch or remembered-profile definition.
No server setting is invented or written.
The pinned OpenAPI's `ProfileVerification` supplies a profile proof and optional expiry after PIN verification.
Restoration reuses that proof through the existing session and validates it with a profile-scoped libraries read before opening content.
Expired or revoked proofs require selection and verification again; PIN verification is never automatically replayed.

The Apple reference is `Silo-Server/silo-apple` revision `1a7cceeaf3b2bfc4f889c00487d19b2c6f843940`.
`Shared/ProfileLaunchState.swift` defaults fresh TVs to `askEveryLaunch` with a remember offer.
Its resolution requires a known remembered profile, matching account epoch and stored proof for a protected profile.
`Screens/Profiles/ProfileLaunchPreferences.swift` persists the device choice through local defaults.
Tizen implements the two requested choices and uses its existing protected KeyManager store for opted-in proofs.
Apple TV user mapping and timed launch choices are outside this change.

Raw PINs remain transient, including when Remember is selected.
Public storage contains the launch choice and a pointer, never the proof.
Unique protected records are committed by a public pointer only after a successful save under the same profile authority.
Opting out removes that pointer before deleting the protected record, so failed deletion cannot restore it.
Logout, a new sign-in and proof revocation invalidate remembrance.
Unavailable or failed storage produces a visible error and explicit Retry; it never claims a successful save.
Continue without saving allows the selected profile to open for this session when device storage is unavailable.

Automated validation uses synthetic native responses and desktop Chromium.
Live server, Tizen KeyManager hardware and software-emulator acceptance remain separate checks.
