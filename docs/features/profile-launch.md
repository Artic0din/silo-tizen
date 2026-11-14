# TV launch profiles

TVs show Who's watching by default.
The first selection asks Apple TV's "Open <name> automatically?" as a small centred alert over the dimmed picker, reading "this Apple TV" as "this TV".
Ask Every Time comes first and Remember second, with focus on Remember, as in the tvOS `.alert`.
Back answers Ask Every Time, as Menu runs the alert's cancel button on Apple TV.
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
Tizen also follows Apple `bbd1e470f0e1d3a99f486d0d7246d11ed1c97d55` for Automatic, Every Time, After 1 Hour and After 12 Hours.
Timed choices expire only after an actual hidden/pagehide interval, on either a warm return or a cold restoration.
An expired warm return stops content and clears the active profile before reopening selection.
Opted-in proofs continue to use the existing protected KeyManager store.
Apple TV user mapping requires an OS-user concept that this web app does not have.

Raw PINs remain transient, including when Remember is selected.
Public storage contains the launch choice and a pointer, never the proof.
Unique protected records are committed by a public pointer only after a successful save under the same profile authority.
Opting out removes that pointer before deleting the protected record, so failed deletion cannot restore it.
Logout, a new sign-in and proof revocation invalidate remembrance.
Unavailable or failed storage produces a visible error and explicit Retry; it never claims a successful save.
Continue without saving allows the selected profile to open for this session when device storage is unavailable.

Automated validation uses synthetic native responses and desktop Chromium.
Live server, Tizen KeyManager hardware and software-emulator acceptance remain separate checks.

## Picker and temporary management

The picker follows the pinned Apple `ProfileSelectionView` and `ProfileTile`: 220 px avatar, avatar-only 1.12 focus scaling, 240 px columns, 44 px horizontal gaps and at most six columns including Add.
The 120 px top/bottom CSS inset compensates for the TV safe area visible in the historical reference in addition to Swift's 60 px vertical padding; it is a measured layout choice, not a new Swift constant.
Names occupy one line and keep their full accessible name when visually truncated.
The account line uses the existing signed-in username, and the remembered tile carries Apple TV's "Apple TV user" caption as "TV user", matching the TV USER Settings section.
A focused name drops 18 px by an offset, so focus never changes a tile's or the grid's height.
The focus ring sits behind the avatar's KIDS and lock badges.
Resolved profile artwork takes priority; failed images retain the raw text or initial fallback, and a successful transparent image removes it.
An emoji avatar also replaces the initial in the top bar, the profile menu and the Settings profile row, at 45% of the avatar, as Apple's `ProfileAvatarView` draws it.
Inter, a CSS ring/shadow and a drawn lock stand in for Apple's fonts, focus rendering and symbol.

Sign out asks in Apple TV's `TVSettingsConfirmationOverlay` (`AccountRemovalConfirmation` on tvOS): a centred dialog over the picker with Cancel, then a red Sign Out, and Cancel focused; Back cancels and returns to Sign out.
Settings and Settings › Accounts show the same dialog through `src/ui/confirmationDialog.ts`.

Change server belongs to the application owner and preserves saved credentials.
It currently opens manual server entry; the saved-server-list destination remains tracked in #127 and is not a platform limitation.

Add uses the server's explicit `POST /profiles` operation without automatic retry.
For a nonempty household it temporarily selects the primary profile, verifies its PIN when required and restores management ownership without changing the remembered launch choice.
When the primary is already open and the fresh list shows it has a PIN, the PIN is asked for again before the form, as Apple's `AddProfileFromMenu` does, because the profile may have been opened before the PIN was set; the open profile stays open.
Cleanup matches the exact account, profile and authority generation so it cannot clear a successor.
An existing primary selection is retained rather than cleared.
The form provides the pinned preset styles, initials, name, optional four-digit PIN and child content-rating/library restrictions.
Preset cells are 96 px tall, with six columns and Shuffle in the Avatar header; the preview column is 360 px wide.
The pinned server does not accept Apple's capability-gated `requests_allowed` field, so it is omitted.
Empty-household creation sends account context only and omits restricted access settings, matching the server's bootstrap restrictions.

Submission is guarded against duplicate activation.
A response that explicitly rejects validation or permission allows editing again.
An uncertain write requires returning to and reloading the profile list before another submission; cancellation does not claim to undo a request already sent.
Late library answers update only their controls, preserving the name, PIN and focus.
Creation and verification do not hand off to Home.

The preset seed generation and picker tint/geometry were ported from the same AGPL-licensed Apple owners; the five DiceBear style IDs and 18-item batches match the pinned client.
Preset images are requested from DiceBear, as in the Apple client.
Their artwork attribution and terms are available in Server > Acknowledgements and the packaged third-party notices.
Automated contract and UI checks use a fake server; they do not establish real-server creation authorization or physical-TV behavior.
The picker retains its existing Sign out action; the separate picker-confirmation case remains tracked under #107 NAV-07.

[Picker calibration and signed simulator reference captures](../evidence/screenshots/96-profiles/README.md) record the source dimensions, substitutions and package identities for later parity work.
