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

Home's marquee, Details and the Details loading frame read one answer, as every Apple surface reads `TitleArtPreferences.shared.showsTitleArt` ([`TitleArtPreferences.swift:25-30, 201-203`](https://github.com/Silo-Server/silo-apple/blob/3651342ee8f819c7f7134a129eedeec2d2646b10/iosApp/iosApp/Networking/TitleArtPreferences.swift#L25-L30), [`TVDetailHero.swift:585-590`](https://github.com/Silo-Server/silo-apple/blob/3651342ee8f819c7f7134a129eedeec2d2646b10/iosApp/iosApp/tvOS/Screens/Detail/TVDetailHero.swift#L585-L590), [`TVItemDetailLoadingView.swift:122-140`](https://github.com/Silo-Server/silo-apple/blob/3651342ee8f819c7f7134a129eedeec2d2646b10/iosApp/iosApp/tvOS/Screens/Detail/TVItemDetailLoadingView.swift#L122-L140)).
Logos show unless the last confirmed answer, kept on the TV per server and profile, is off ([Skyline browse shell](skyline-browse-shell.md)).
Home reads the answer when it loads and after Settings closes; Details makes no title-art read of its own.
A pending or failed read keeps the last confirmed answer, or logos when there is none, and Details shows no title-art error.
Confirmed false, including an administrator's inherited false, starts zero logo requests on Home, Details and the loading frame.
Settings' confirmed answer applies at once, and an answer that changes while Details is open repaints its heading without moving focus.
Item and detailed-season headers share the existing DetailsState lifecycle and renderer.
Missing or broken artwork keeps text, and transitions never wait for logos.
Late image callbacks cannot replace headings after stop, profile/server authority loss or while the connected page is hidden during playback.
Older servers identified by a missing capability endpoint (404/501) or a pre-16 manifest drop the remembered answer, so logos show again; this is not a fabricated saved true value.
Person names/photos are unchanged.
The loading frame shows the opening card's logo, as Apple's route seed carries it from feed rows: Home, Recommendations and a library's Recommended rows ([`Route.swift:137, 155, 209`](https://github.com/Silo-Server/silo-apple/blob/3651342ee8f819c7f7134a129eedeec2d2646b10/iosApp/iosApp/Navigation/Route.swift#L129-L209)).
Search, library grids, collections, lists, box sets and filmography open from catalog cards, whose seed has no logo ([`Route.swift:180`](https://github.com/Silo-Server/silo-apple/blob/3651342ee8f819c7f7134a129eedeec2d2646b10/iosApp/iosApp/Navigation/Route.swift#L172-L180), [`Models.swift:242`](https://github.com/Silo-Server/silo-apple/blob/3651342ee8f819c7f7134a129eedeec2d2646b10/iosApp/iosApp/Networking/Models.swift#L242)), so their frame keeps the text title even when the server sends one.
The frame and Details show the text title until a logo first decodes.
A logo that has decoded stays in the heading for the rest of that visit, including later repaints, matching [`TVDecodedLogoTitle`](https://github.com/Silo-Server/silo-apple/blob/3651342ee8f819c7f7134a129eedeec2d2646b10/iosApp/iosApp/tvOS/Screens/Detail/TVDetailHero.swift#L525-L583) seeding its pipeline cache.
When the card and the loaded title name the same logo, the loaded heading therefore opens on the logo the frame decoded.

The primary sources are the [server manifest](https://github.com/Silo-Server/silo-server/blob/cc8514943289045e7b9f7ac8d36d4968bfe93926/contracts/settings/v1/manifest.json), [server wire encoder](https://github.com/Silo-Server/silo-server/blob/cc8514943289045e7b9f7ac8d36d4968bfe93926/internal/apiv2/settings.go) and [Apple title-art plan](https://github.com/Silo-Server/silo-apple/blob/f33479404712737499b22365430db1885cf6c6ab/iosApp/iosApp/Networking/TitleArtPreferences.swift).
The binding [Skyline guide](https://github.com/Silo-Server/silo-apple/blob/f33479404712737499b22365430db1885cf6c6ab/docs/skyline-design-guide.md) was verified with SHA-256 `2d42d292e01ab6ee539278b63c286756fc432edf876a9286a33c9e853672cac2`.
Desktop Chromium tests prove synthetic UI, focus and request behavior; the Chrome 108 build proves compilation compatibility, not TV rendering or AVPlay decoding.
