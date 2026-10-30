# Title art

General Settings offers **Show Title Art** and **Apply to All Devices** when the server supports `ui.title_art`.
The screen shows the effective value and whether its source is the inherited default, this TV or all devices.
All Devices reflects the server's effective `source=profile`; clients do not recompute precedence.
Explicit profile and this profile-device row are read separately from the effective answer.

Show Title Art writes `profile` while All Devices is on and `profile_device` otherwise.
Turning All Devices on writes the current effective boolean at `profile`, retaining stored device rows.
Turning it off first pins the effective boolean to this `profile_device`, then deletes `profile`.
An unchanged All Devices choice sends no write, and DELETE 404 means already absent.
No reset control is added.

SettingsState serializes this plan using its existing busy/error/Check and retry owner.
A refused first PUT prevents DELETE; a partial plan remains incomplete.
Lost answers and Retry read both scopes and the effective answer before proceeding and skip achieved steps.
A completed device step is skipped only while its fresh row still holds the planned boolean; a changed or removed prerequisite stops the old plan without overwriting it.
Contradictory explicit and effective snapshots also stop the plan before further writes, retaining the observed state for reload.
A newly observed profile choice or revision stops the old plan and asks for a reload instead of deleting the newer choice.
There is no atomic settings batch or conditional DELETE in this contract: another device can still write between the final read and mutation, and that unavoidable race is last-write-wins.
These controls are not a cross-device transaction.

Item and detailed-season headers share the existing DetailsState lifecycle and renderer.
Pending or failed/malformed supported reads show accessible title text and start no logo request.
Failed reads leave playback and **Retry title art** reachable.
Confirmed false, including an administrator's inherited false, starts zero logo requests.
Confirmed true may request artwork; missing or broken artwork keeps text, and transitions never wait for logos.
Late reads and image callbacks cannot replace headings after stop, profile/server authority loss or while the connected page is hidden during playback.
Returning rechecks policy without a persistent cache; optional reads preserve the open synopsis and focus.
Older servers identified by a missing capability endpoint (404/501) or a pre-16 manifest retain the built-in logos-on compatibility behavior; this is not a fabricated saved true value.
Person names/photos and the text-only marquee are unchanged.

The primary sources are the [server manifest](https://github.com/Silo-Server/silo-server/blob/cc8514943289045e7b9f7ac8d36d4968bfe93926/contracts/settings/v1/manifest.json), [server wire encoder](https://github.com/Silo-Server/silo-server/blob/cc8514943289045e7b9f7ac8d36d4968bfe93926/internal/apiv2/settings.go) and [Apple title-art plan](https://github.com/Silo-Server/silo-apple/blob/f33479404712737499b22365430db1885cf6c6ab/iosApp/iosApp/Networking/TitleArtPreferences.swift).
The binding [Skyline guide](https://github.com/Silo-Server/silo-apple/blob/f33479404712737499b22365430db1885cf6c6ab/docs/skyline-design-guide.md) was verified with SHA-256 `2d42d292e01ab6ee539278b63c286756fc432edf876a9286a33c9e853672cac2`.
Desktop Chromium tests prove synthetic UI, focus and request behavior; the Chrome 76 build proves compilation compatibility, not TV rendering or AVPlay decoding.
