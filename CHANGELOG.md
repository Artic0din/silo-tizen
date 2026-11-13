# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Added theme music, as on Apple TV: Settings › General has Play Theme Music and Loop Theme Music, and a movie, series, season or episode page plays the title's theme quietly while it is open, stopping before playback starts.
- The Watch Party lobby now votes and readies up as on Apple TV: in a room where everyone votes, each suggestion shows its live vote count with the leader outlined and a tick on yours, Select votes or takes the vote back, Suggest a title adds one from the picker, and the host starts the winner. Guests can mark I'm ready, and everyone sees it on their seat.
- The Watch Party lobby now updates live over the room socket: people joining or stepping away, readiness, the host's pick and controls, and the party ending reach every TV in the room as they happen, with Apple's Connecting and Reconnecting states. Leave party and Back as the host now leave this TV only, as on Apple TV; End party is what ends it for everyone.
- Added the Watch Party lobby: the code with an invitation page and QR, who is here, and, for the host, choosing a title from the group's picks and watchlists, Start for everyone, Who chooses, Playback controls, Return everyone to lobby and End party. Starting opens the player on the party's file without playback sync, and the lobby shows the room as it was when this TV last heard from it.
- Added a Watch Party hub, off by default: turn it on under Settings › Server › Extra Features and, when the server supports synchronized parties, Watch Party appears in the profile menu with Start a party, Join party and a lobby that shows the code and who is here; going Back as the host ends the party. Playback together is not built yet.
- Playback lowers the quality when it keeps buffering, as Apple TV does: it asks first, or lowers Auto at once and offers Restore quality, depending on `playback.buffering_quality_mode` (Automatically by default), with the same prompt, undo pill and notices.
- Added HDR on Playback. A TV that reports HDR, with the HDR setting on, claims HDR10 for direct play. HDR10+ and HLG stay unclaimed: the probe is one boolean, and Samsung does not document those formats for every Tizen 8.0 TV. Dolby Vision is not a Playback row: Samsung exposes no Dolby Vision support check, and this client claims no Dolby Vision profile.
- Added subtitle search and download, plus in-player delay, size, position and appearance controls, during playback.
- Added player chapters, playback stats, richer title information, supported speed and aspect controls, and an in-player Auto-play next toggle.
- Added Show Next Up to Playback Settings with five prompt timings and profile inheritance.
- Showed Up Next before playback ended with Play Now, Keep Watching and an On Deck row, and refreshed autoplay at episode completion.
- Playback settings show Connection speed and Test speed when the server advertises `connection_speed_v1`.
- Added Lower quality when buffering (Never, Ask first, Automatically) and, when the server has learned a limit for this connection, "Limited to 44 Mbps after buffering on Oct 17" with Reset to Playback settings, as on Apple TV.
- Sent the last measured connection speed when playback starts, while it is still current, so Auto can plan the first stream with it.
- Added Paired Silo Profile on General, showing the profile this TV reopens and opening the profile picker to change it.
- Added Remove Request for a failed request of yours, including the confirmation, the notice, and focus on the card that takes its place.
- Hid unwatched episode stills and descriptions from Playback when the server supports the profile spoiler settings.
- Loaded Person filmography in 60-title batches while scrolling and refreshed incomplete person metadata automatically.
- Show Trailers & More on movie and series Details for local extras and YouTube listings, using Apple's card size and the 76px gap to the next heading. Local extras still play from the start. YouTube listings stay on their card because this TV cannot play them.
- Added description translation on Details and the featured marquee, matching Apple TV's Translate Description action, Translating… status and Translated by AI label.
- Added Change Account with several saved accounts per server and account management.
- Added the audiobook contract decoders and API operations that the Audiobooks screens will build on. Nothing visible changes yet.
- Added the Audiobooks tab (Settings, General, Show Audiobooks) with square covers and the audiobook detail: cover, author and narrator, progress, Chapters, About, narrations and related rails. Home, For You and Search open audiobook cards on that detail, and Search can filter to Audiobooks. Play stays off until audiobook playback lands.
- Added UI tests that the Audiobooks tab needs both Show Audiobooks and an audiobook library the profile can see, and that focus stays on Home when the tab appears or goes. Nothing visible changes.

### Changed

- The player's Subtitles tab now matches Apple TV: TRACKS and OPTIONS sit in two columns, option values line up on the right with chevrons, Appearance shows its Aa glyph, and pickers are titled in sentence case. Pickers float over the dimmed pane and close with Back, selected tracks show a checkmark without a highlight, and Search and AI rows show Apple's symbols. Video gains Apple's PLAYBACK rows (Quality, Speed, Aspect, each opening a picker) and a SYNC column with Subtitle delay beside Auto-play next. Up and Down stay in a column, Left and Right cross between columns, and tabs change only on the tab bar, as on Apple TV. The panel and pickers use translucent glass, selected tracks show Apple's full-size checkmark, the columns fill the panel, and long option values truncate as on Apple TV.
- Person page text now matches Apple TV's size and width: the name, facts, biography, Filmography heading, title count, filter chips, poster captions, initials and the Loading metadata capsule use Apple's point sizes corrected for Inter's taller capitals, with letter spacing fitted to Apple's SF Pro. The Loading metadata capsule uses Apple's dimmer text and background, and the filter chips are Apple's 46px tall, so the filmography grid starts where Apple's does.
- Details text now matches Apple TV's size and width: the title, rating chip, cast, facts, rails, box set page and error pages use Apple's point sizes corrected for Inter's taller capitals, and each line's letter spacing makes it run as wide as Apple's SF Pro.
- Details popovers now match Apple TV: Version, Audio and Subtitles share More's glass panel, reopen on the selected track, close with Left or Right, scroll long lists, dim subtitles that can't be delivered, and a failed change, season watched or shuffle shows Apple's alert. More adds Shuffle Season and, with Watch Party on, Watch Party.
- Holding Select on a card now opens a menu that looks and reads like Apple TV's: it appears beside the card at once, with a symbol on each row, Apple's labels, and Remove from Continue Watching or Remove from Next Up on those Home rows. A change that fails shows "Couldn’t Update Item". An empty Home now says "Nothing to watch yet", and Home no longer shows refresh messages under its rows.
- The player's subtitle options now use Apple TV's wording: Search Subtitles…, and pickers titled Subtitle Delay, Subtitle Size, Subtitle Position, Subtitle Style, Subtitle Font, Text Color, Text Opacity, Outline Color, Background Color and Background Opacity. As on Apple TV, a picker's title stays in view while its options scroll.
- Secondary text, such as counts, settings descriptions and metadata lines, now uses Apple TV's colour: the primary text colour at 60%, instead of a lighter flat grey. Watch Party captions, hints, presence and suggestion lines use the same colour at Apple's lower strengths.
- Details starts the highest-resolution version, honouring the Resolution cap in Playback settings, and lists versions as resolution, video codec, DV or HDR, and audio codec, as Apple TV does. It no longer starts the first version the server lists, and no longer prints the edition in the Version list.
- The next episode, On Deck and shuffle picks start the file that fits the Resolution cap, as Apple TV does, instead of the last-played or first-listed file.
- Change Account and Settings › Accounts now list the open server first, then servers and accounts by last use, as Apple TV does. Settings no longer shows "0 profiles", a card spins while its account opens, and SIGN IN AGAIN uses the warning colour with an open lock and a dimmed tile.
- Change Account fades the edge of the server and account columns that has rows hidden past it and shows a chevron under the column pointing that way, as Apple TV does.
- The profile PIN prompt now matches Apple TV: the profile's avatar and name, four dots, a number pad with Cancel below it, and the PIN sends itself on the fourth digit. A wrong PIN turns the dots red and shakes them, and the entry clears. Back deletes a digit or leaves when none is left. Holding OK on a key enters one digit, and a lockout with no wait given says to try again later.
- Pinned the paused seek preview to Apple TV's footer layout with a regression test. Pausing alone shows no preview card. A timeline scrub shows it with its bottom edge 8px over the series line, which draws above the card, and the title stays clear. Nothing on screen changes.

### Removed

- Removed the custom kbps field and Save action from the Maximum Bitrate picker. A stored cap outside the preset list still appears in that list.
- Removed the Settings Hidden Libraries editor and duplicate Manage Servers navigation; existing hidden libraries can still be restored.
- Removed Details Read synopsis, its expanded view, #66's personal star rating control, and Season details to match the controls reachable on Apple TV.

### Fixed

- Home now keeps its posters, backdrop and title art when it opens from the saved snapshot and the first live read fails, as on Apple TV. The signed artwork links are kept in the TV's protected key store, never in ordinary app storage.
- The Person page's empty and error states now match Apple TV: an empty Filmography shows the film icon, "No titles found" and its explanation; a Filmography that failed to load shows Apple's error panel with Try Again under the filters; and a person who could not be loaded gets Apple's full-page error, with Go Back first when the person no longer exists.
- The top bar and its menus now match Apple TV: tab labels are white and Apple's size, long tab names get Apple's full width, tabs and the avatar animate into focus, the avatar keeps its disc when focused and grows slightly, nameless profiles show a person glyph, the menus have Apple's lit surface and filled icons and grow from and fade back toward their tab, and Back on Home returns to the Home tab before offering to exit.
- Title pages no longer show "Loading personal actions." under the actions or in More while your watched, favorite and watchlist state loads; as on Apple TV, the actions simply appear, and More lists Add to Favorites right away.
- A series page now picks its season again, as Apple TV does, after you mark that series watched from a card, including when you go Back to a page that was already open, or once 20 other title pages have opened since; a favorite or watchlist change keeps the season you were viewing, and so does a series page that a related title replaced.
- Made the fast season-walk test on a series page wait for each season read to reach the test server before the next season, so a slow runner can no longer drop one from its count.
- The Home preview now keeps pace with focus as on Apple TV: the title, details and description change the moment a card is focused, with no fade or overlap, and only the backdrop waits until focus rests (after a row change, until the moment Apple TV swaps it) and fades in with Apple's curve over its blurred preview. Moving to another row reads the new title's details at once. Home cards show that blurred preview while their artwork loads, fade their artwork in as it arrives, and keep the preview if the artwork fails, a season on Next Up is titled by its series, Explore all loses the extra shadows and heavy outline, its label shrinks to fit, Select presses the card in, and the hero and card text and badges match Apple's sizes.
- With Standard or Large posters, moving down to Related on a title page now stops where Apple TV does, instead of up to 112 px lower.
- Made the empty Home test hold the TV clock while Home remounts, so on a slow runner the remembered card's preview can no longer read that card before the empty answer arrives.
- The seasons, episodes and lower rails on a title page now match Apple TV: season pills are Apple's size and spacing, sort by number with Specials last, and hold Select to Mark Season Watched or Unwatched; a loading season shows skeleton cards and an empty one reads No episodes available; watched episodes dim, the date line uses Apple's size and spacing, and a movie page lists Cast, Trailers & More, the box set, Related and Details in Apple's order. Related shows up to 12 titles behind four placeholders, and picking a related title from a related title replaces that page, so Back returns to where you started.
- A title page now opens like Apple TV's: a quiet skeleton of the hero, filled with what the card already knew, replaces the "Loading" page and its Back button. The hero leaves the poster out when a title has no backdrop, shows the backdrop's preview while it loads and a film mark if it fails, fades the logo in, and splits "Title - Subtitle" titles. The Version, Audio and Subtitles readout keeps its labels while values load, long values shrink to fit, ratings that do not fit drop whole, the meta line and synopsis take Apple's type size and line spacing, and the translation note carries its symbol. Returning to the hero scrolls at Apple's pace, a season 0 no longer counts toward "N Seasons", and a focused episode shows only its own ratings once its details load.
- Made the Watch Party ballot, Watch Party from More, Filmography card menu and episode Search tests wait for the server answers they depend on instead of racing them, which removes their intermittent CI failures.
- Who's watching now matches Apple TV: the tile says Add, the remembered profile reads TV user, a focused name no longer shifts the picker, the lock badge draws its padlock, the focus ring sits behind the KIDS and lock badges, and Change account shows Apple's two-person icon instead of a server stack. Sign out on Who's watching, in Settings and in Settings › Accounts now asks in Apple TV's centred confirmation over the screen, with Cancel focused, instead of a full page. The remember prompt is now a centred alert over Who's watching that asks "Open <name> automatically?" with Ask Every Time or Remember, and an emoji avatar now shows in the top bar and Settings instead of the initial.
- Title, season, box set, audiobook and Explore all pages that fail to load now show Apple TV's error screen: a warning icon, the headline and message, and Try Again. A missing or blocked title offers Go Back first with Try Again below it, and the remote's Back still leaves, so the extra Back button and the title above a failed Explore all page are gone.
- The Home row headings, such as Continue Watching, now match Apple TV's text size, letter spacing and play icon size and spacing.
- The Home hero's meta line, synopsis, air date and cast line, and badges now match Apple TV's text size, spacing and line width: the synopsis has Apple's taller line spacing and wraps at the same word, and the badges are Apple's size.
- Played every part of a multi-part Shuffle pick in order before the Shuffle moves on, as on Apple TV. Each part starts from its beginning, prefers the resolution of the part before it and otherwise takes the first candidate, and a missing part moves the Shuffle on. Between parts the screen shows the loading spinner instead of the Playback ended screen.
- Made Watch Intro count down like Skip Intro in the player: five seconds, starting when the automatic skip is issued and frozen while paused. The Skip Intro, Skip Recap, Skip Credits and Watch Intro pills now stay on screen and usable while the options panel is open or a seek preview is showing, and are disabled only during a timeline scrub, as on Apple TV. A reconnect or replan also pauses both countdowns, and a short loading screen no longer restarts the pill's fill.
- Started every Shuffle pick from the beginning at its first part, with no resume, as Apple TV does, for Shuffle from a library, collection or series and for the next pick in the player.
- Drew Apple TV's default artwork for posters, thumbnails, Search box sets and episode stills with no artwork or a failed load: dark base, three faint brand glows and a film, tv, headphones or book mark by type, in place of the title text. Artwork that is still loading shows Apple's darker placeholder instead.
- Changed the Series Details episode rail error to Apple TV's text-only "Couldn't load more episodes. Move away and back to retry." and removed the Retry more episodes button. The error now uses Apple TV's 18-point secondary text. Choosing another season or reopening Details, including going Back to it, now clears the error and reads each missing neighbouring season at once, as Apple TV does, instead of waiting for focus to reach the rail edge.
- Hid the Series Details rail edge error while its retry runs and showed it again if it fails, as Apple TV does. Focus stays on the edge card.
- Matched Apple TV's skip pills in the player. Skip Intro shows for five seconds with a filling bar, Back takes it down, and Skip Recap and Skip Credits stay up for the whole recap or credits. After an automatic intro skip the pill reads Intro skipped over Watch Intro, with the same filling bar. The Skip Recap and Skip Credits pill is 260 px wide and widens to 360 px with focus, and Back on it works as it does anywhere else in the player. Credits skips no longer offer an undo, and Skip automatically never offers Skip Intro.
- Hid "Could not load more episodes." and Retry more episodes on Series Details while the retry runs, and showed them again if it fails, as Apple TV does. Focus stays on the edge card.
- Kept the top bar on Requests opened from the profile menu, so Up from the first row reaches it and Back returns to the tab underneath. Requests closes back to that tab when the server turns requests off. Watchlist, Favorites and Requests now replace each other, so Back from the bar returns to the tab, and a page opened above Requests stays open until you leave it.
- Retried a season that failed to load beside the Series Details episode rail when focus reaches the rail edge, and re-read a season whose load was cancelled when its chip is focused again, as Apple TV does.
- Said a finished AI subtitle was saved but not turned on when the refreshed plan marks it unplayable, as a downloaded one already does, instead of doing nothing after Select.
- Made the Home offline-recovery, For You offline, Browse Recommended reselect and Player hold tests wait for the page's own retry timers, Details read and clock set-up instead of assuming a fast runner, which removes their intermittent hosted CI failures.
- Restored the Continue Watching progress bar with Apple TV's look: a 3px bar flush with the card's bottom edge, a faint full-width track, and a light fill for the watched share. Box set search results use the same bar.
- Listed a subtitle the server marks unplayable as dimmed with Unsupported format and made Select on it do nothing, so picking it no longer ends playback. Automatic picks skip it, a saved subtitle preference naming one falls back to the next playable pick, and a Details choice of one starts with subtitles off. A downloaded or AI subtitle that is unplayable says it was saved but not turned on, or shows Unsupported format.
- Showed Who's watching after signing in even when the TV could not save that the remembered profile was cleared.
- Kept Who's watching after a sign-in across a restart even when the TV refused to clear the remembered profile, by tying each remembered profile to a sign-in epoch stored with the account, as Apple TV does. A profile remembered before this update is asked about once more.
- Kept retrying the removal of a replaced profile unlock when the TV refused to delete it, so choosing a new remembered profile no longer leaves the old unlock stored for good.
- Moved the Series Details episode rail 40px left when its loaded window includes the series' first season. A later season whose earlier pages are not loaded keeps the previous position, and reopening Details starts from that season's neighbor window.
- Asked before signing out from Who's watching, while profiles load, and when profiles fail to load. Cancel stays focused, and Cancel or Back returns to Sign out.
- Choosing another account opens its only profile when that profile has no PIN. An expired sign-in shows "You were signed out of {server}. Sign in again." with the username filled in, or Change Account when another account is still signed in.
- Drew sans-serif subtitle captions in the bundled Inter face at weight 600, in the Settings preview and during playback.
- Loaded in-player subtitle delay and appearance when the settings contract tags a scope with the revision that added it.
- Cleared a leftover device subtitle delay once per profile, after an owed delay write settles, and retried a failed clear instead of sending it on every open.
- Kept the playback clock on Inter's 34px line so the scrubber stays put while the face loads, and a scrub thumbnail placed before that swap does not sit 1px too low.
- Matched the person biography to Apple's 26px regular body, a 30.62109375px line, and a seven-line clamp.
- Matched the person page name to Apple's 85px line box, so the name starts 10px below the portrait and the facts start at 117px.
- Kept direct play running when a subtitle choice stays on the same stream, and showed that sidecar's cue at the picture's time after a seek.
- Matched the subtitle preview caption's height to Apple TV.
- The collapsed A–Z circle is plain.
- Hid the TV's native scrollbars, drew the History returning mark as an outlined television, drew the collapsed A–Z index as Apple's 10px circle plus the faint letter marks, and centred Related captions on the poster.
- Removed the Continue Watching playback bar, kept Search posters 247px apart, restored biography paragraphs, and matched Related captions and the Written by order to Apple TV.
- Show the series name and episode tag while playing when Resume or Start Over starts from the series page and the episode item omits them.
- Show that same series line when the episode starts from the episode list or Continue Watching and the episode item omits it.
- Send a known subtitle track with playback start, and correct it before the picture opens when the plan chooses another track.
- Auto start no longer asks for a full subtitle when the audio that will play already matches that language.
- Move the scrub thumbnail with the playhead, 101.0234375px above the handle, in a 236.265625px card.
- Open the hidden player panel on Video, and the options button on the last tab, which starts on Info.
- Kept the page transparent over AVPlay. The black opening is a loading backdrop only, and a previous screen in the same root is not painted while the player is up. Once a frame has shown, that backdrop stays off through a later load, reconnect and restore.
- Kept the other series' title and the fresh season and episode on an On Deck play, so the player can show them.
- Blurred an unwatched On Deck episode still when image spoilers are on, and left series art sharp.
- Waited for a pending Auto-play save before an ended episode decided whether to continue.
- Matched Apple TV playback opening, hidden Up, the title lines, and the panel: a spinner on black, Up reveals the scrubber, pause shows no status line, and the open panel hides the transport until Back.
- Stopped Home from asking for every title's details as soon as it appears. The card you rest on is read after a short pause, Continue Watching reads the file you were playing four titles at a time, and For You warms only the first few cards that are missing a rating.
- Kept focus on a season you select right after a series opens, instead of moving it to Play or Resume.
- Matched Settings row fill and the On and Off value brightness to Apple TV.
- Matched Profile Selection's caption to each launch choice. Settings footers use a 23px line so section labels sit at Apple's measured rows, the subtitle preview stays 958 by 150, and pane rows use a regular label with a 1px white stroke at 9%.
- Tightened Inter tracking so titles match Apple TV's text width, kept a Calendar title on one line, and left a compact home title of about 152px whole in the artwork frame.
- Matched the Playback quality footer and Maximum Bitrate labels to Apple TV.

- Showed Calendar noon as 12:00 pm on an en-GB TV, and kept the first Search person visible.
- Kept a decoded Details title logo in place across later repaints, so the metadata row no longer jumps back to the text title during that visit.
- Matched the Details metadata row to Apple TV: the content rating and advisory age sit in outlined chips sized to the 18pt line height so the stroke stays inside the row, and the year, runtime and genres are separate text facts on that same row.
- Removed the extra focus outline on Accounts rows and Cancel. Change Account keeps the backdrop stage the previous screen left, warm after Who's watching and blue after sign-in, and an unfocused selected server is white at 14%.
- Down from a Search person lands on the first title column at or past that person's centre, and a filter pill lands on the title card under it. A short title row keeps the column that entered it, so the next request is the one that lines up with that column. Up from Requests enters the last title row even when no card lines up, and stays put when the first person does not line up with the request. Search loads 60 titles per page, so 25 results have no pager.
- Back from Settings now returns to Home, including when Settings was opened from another tab.
- Down from the profile avatar enters Switch Profile, including before the menu's dwell finishes. After Back closes it, Down reaches the first Continue Watching card.
- Matched the library Browse grid to Apple TV: the mode pills are gone, and Up from Sort returns to the top bar. Episode rows now crop the previous card at the 100px inset, the focused still lifts by 5%, and Cast, trailer and related rows start at that inset and paint to the screen edge.
- Kept Play focused when a movie's Details opened, even if the first focus claim did not stick, and kept that claim from leaving a card-actions dialog or ignoring a Play button that appears after the page opens.
- Reloaded the subtitle language catalog when Try Again or Choose another language follows a catalog failure, instead of searching the previously chosen language.
- Returned subtitle pickers to their originating pane and row after selection or Back, while preserving focus in another active tab.
- Kept unavailable subtitle display capabilities quiet while reporting failures to load advertised preferences.
- Preserved saved subtitle appearance when editing from Off, restored inherited values after clearing TV overrides, and hid unsupported native subtitle controls.
- Kept Info Retry visible during remote navigation and restored selected video settings after hidden stream preparation.
- Showed the effective autoplay setting after saving.
- Kept a debounced skip when an earlier scrub seek landed on the same plan.
- Disabled audio and quality choices while a subtitle report is still pending.
- Kept a running skip hold when the earlier seek landed on the same plan.
- Added the Show Up Next episodes icon. A seek during discovery finishes the open panel, and a failed On Deck read can be tried again in that playback.
- Read a successor's catalog presentation once, so playback ticks do not request it again.
- Scrolled a long Info overview upward before leaving it, and kept a saved Auto-play value ahead of an older discovery read.
- Reported a failed subtitle-language catalog with a retry, and said when a downloaded subtitle was saved but could not be turned on.
- Retried Up Next discovery after seeks, preserved fresh autoplay settings at EOF, and kept captions inside the video preview.

- Updated composed EOF checks for Apple TV's Play Now, On Deck and tail replay behavior, and isolated focus checks from background reads.
- Kept focus on the selected On Deck title when more candidates arrived.
- Restored full-screen playback after a paused seek left the Up Next window and offered Play Now before later On Deck lookups finished.
- Kept media keys working during the pre-end Up Next prompt, cancelled pending scrub timers when it opened, and resolved On Deck artwork against the connected server.
- Preserved newer subtitle choices when an unanswered report required connection recovery.
- Applied queued subtitle choices after a replacement stream finished preparing while hidden.
- Restored sidecar captions and queued choices after refused subtitle reports, aligned subtitles after suspended preparation, and honoured published HLS rendition order.
- Reported an HLS subtitle alignment failure instead of showing a track that the native player could not select.
- Allowed pause during subtitle reports, queued choices needing a new stream, and replanned subtitle tracks that the native stream could not identify.
- Cleared sidecar captions when selecting embedded subtitles and restored the last confirmed subtitle after a queued choice was refused.
- Added Retry for retryable playback startup failures and exhausted route recovery.
- Matched the measured player layout, showed episode context, hid idle controls from every transport focus, and held seek times until playback caught up.

- Preserved repeated skip taps while seeking and disabled track-list scroll animation with reduced motion.

- Followed playback after an external resume during scrubbing and preserved newer Play/Pause choices while a scrub seek landed.
- Resumed committed scrubs after a server reanchor, kept Skip reachable with the remote, and let navigation cross Audio while its choices loaded.
- Kept the latest Play/Pause choice when remote presses arrive during a seek.
- Resumed playback after a timeline scrub once the seek finished, and let the remote move through an empty audio list.
- Kept the Details hero pinned when action focus survived a repaint during its return scroll.
- Opened a remembered profile and cached Home promptly on cold start while checking the saved session in the background, then refreshed the top-bar profile artwork from the reconciled summary.
- Kept a detail Cancel's hub card visible while the shared gate still owns it, even when a refresh already sees the server's cancelled state, and left hub cards alone so a failed quiet refresh keeps its earlier rows.
- Kept the unconfirmed Cancel copy on the detail action only, so the hub list banner does not duplicate it.
- Captured the neighbor before an uncertain list Cancel or Remove readback, so focus lands on that card when the row is already gone.
- Settled an unconfirmed detail Cancel hold after a successful request readback, and kept cancel/remove focus on the captured neighbor when moved focus was the removed card.
- Kept an unconfirmed detail Cancel in the shared Requests hold so the hub cannot offer Cancel Request again before a read settles it.
- Kept a held Select on Remove Request from dismissing the confirmation when focus moves to Keep request.
- Shared one Requests mutation gate between list and detail Cancel so navigating between them cannot post a second cancellation.
- Kept a cancelled Requests card off the hub when an ordinary route load that started before Cancel finished still answered with the pending row.
- Kept duplicate Cast credits focused after trailer refreshes reordered them and resumed interrupted trailer discovery after returning from playback or watched-state navigation.
- Added Find Trailers to movie and series Details and matched cast entries and overflow, episode captions and metadata order, season pills, synopsis brightness, and More menu glass styling to Apple TV.
- Showed the full runtime and version, audio and subtitle details for each focused episode after focus settled.
- Cancelled episode detail dwell on leaving a card, preserved explicit selector requests, and released older settled episode playback owners.
- Kept explicit season selections on the first episode through cached Calendar revalidation and restored shuffle and advisory preferences after offline Details recovery.
- Revalidated the saved server identity after an offline start before sending restored sign-in credentials, preventing credentials from reaching a replacement deployment.
- Recovered offline season episode controls automatically, preserved episode refusals across cached revisits, and reused visited Details for offline card actions.
- Retained cached next-episode controls and remaining artwork during outages, restored personal-action retries in card menus, and kept unsent writes retryable when session refresh failed.
- Restored saved sessions and remembered profiles during unreachable cold starts, retained cached Series Play offline, and matched uncached Home and For You errors to Apple TV.
- Retained signed Details artwork in session memory, matched offline Details errors and episode Retry to Apple TV, and restored the hero when recovery removed Retry.
- Cleared only the signed-out account's cached browse content, including offline saved-account removal.
- Preserved cached Details artwork and supporting content offline, protected visited titles from Home enrichment eviction, and retained the selected season during recovery.
- Restored the last available Details hero action on Up, falling back to Play or Watchlist when Start Over disappeared or a selector was disabled.
- Refreshed episode spoiler protection after Settings changes and preserved saved switches during overlapping requests and failures.
- Aligned Details supporting-section headings when moving Up and Down, restored visible Movie Cast to the page top, and removed duplicated space below the Details table.
- Opened fresh Details presentations at the hero and preserved each earlier presentation's focus and scroll when the same title appeared again in the route stack, including entry from Search.
- Episode cards opened their series on the selected episode, while remote Play resumed directly and Continue Watching offered Play or Resume in Card actions.
- Kept cancelled season reads quiet, retained failed Retry focus and revisit state, restored the selected season when reopening a series, and removed unresolved hero bars and the incorrect loaded-predecessor rail offset.
- Kept season heroes and Play labels on the latest selection, showed loaded episode summaries immediately, restored Series on Play with its overview, and limited season recovery to one requested read.
- Selected seasons on resting pill focus without rereading cached episodes, bounded missing-season reads during remote sweeps, and centered the selected season pill like Apple TV.
- Search Select on an episode or season opens that series' Details. Enter on a result no longer starts playback or writes watch history.
- Restored VIDEO skip intervals and corrected Settings pane margins, Sign Out, subtitle appearance cards, picker indicators and server credits after the full Apple TV comparison.
- Matched Settings rail icons, row spacing, pane headers, subtitle appearance order and picker hints; pinned the rail and preserved the pane behind modals.
- Stopped featured descriptions from starting an automatic translation after focus moved to another card.
- Corrected subtitle profile edits under device overrides, preserved focus after dismissed launch saves, and reset sign-out confirmation to Cancel on each opening.
- Matched Remove Server to Apple TV's confirmation and returned Cancel and Back to the first account.
- Corrected Details More dots and compact action rows, added capability-gated Shuffle Series using existing shuffle playback, and made unfocused Play adapt to the backdrop like the round actions.

- Preserved Settings row fixtures across contract refreshes, offered automatic-skip undo after successful seeking, and refreshed catalog metadata for changes already saved on another device.

- Restored supported subtitle rows, centred Settings pickers and privacy handoff, and aligned pane order; deferred the Show Next Up editor until its playback reader lands.

- Added supported Apple TV settings for poster size, advisory age, profile timing, episode playback, metadata and subtitle appearance, and kept profile subtitle edits independent of narrower overrides.

- Corrected Playback Settings to edit this TV's supported overrides and restore profile inheritance without changing profile defaults (Apple/Samsung native parity pending).
- Aligned supported Settings rows with Apple TV's resolution choices, bitrate presets, value columns, profile selection and sign-out navigation.
- Added the Subtitles profile language, behavior and forced-subtitles rows, the profile account line, and Apple's sign-out confirmation.
- Kept loaded-season episode focus free of reads, limited outer-edge loading to one debounced season request, required Retry for failed neighbours, and preserved the window during translation polls.
- Kept Series episodes in Apple's continuous loaded-season window, clamped entry and remote focus at the final episode group, restored resume bars and edge peeks, and corrected the row's leading inset; the later corrections await signed comparison.
- Made application sign-in tests wait for approval and the storage notice before continuing to profiles.
- Matched Details More popovers and Start Over controls to Apple TV, and selected series playback from the current season's next-up suggestion.
- Stopped a device-code poll from going out when its wait ended as the screen hid. A poll already sent still finishes, and coming back polls at once.
- Kept Search's navigation column when a square People portrait animates on focus.
- Restored Cast focus clearance and corrected Details episode spacing, picker selection, Related badges and action glyphs against Apple TV measurements.
- Corrected Details caption gaps, resting Cast spacing, series colours and genres, and intrinsic Versions sizing.
- Activated Series seasons on resting focus, preserved complete episode scroll steps, and corrected Details spacing, hero contrast, Versions and SDH subtitle presentation.
- Corrected the Home title-art regression test to preserve Details' bottom-aligned logo slot, with separate Home, Series and Movie geometry checks.
- Corrected Details season entry, cast scrolling, rail spacing, hero text and playback picker sizing, labels and selection checks against Apple TV.
- Kept season selection on its pill, restored the Details hero on Up, and aligned title art, episode spacing, recommendations and playback popovers with Apple TV.
- Kept Episode and Season playback controls visible when their titles and synopses wrap.
- Kept long Movie playback controls visible, placed Season headers before episodes, refreshed shared preferences from uncached episodes, and resolved Auto subtitle previews using the selected audio language.
- Preserved unresolved episode track choices across repeated Series refreshes until readback confirms them, without replaying uncertain saves.
- Restored painted Details text and season labels, Play entry focus, selected-season navigation, facts tables, compact track readouts and anchored track pickers.
- Hid unavailable or empty Related rails after loading, removing their extra error and Retry focus stop.
- Kept Details artwork inside Home's shared top-right frame, displayed content-rating badges, and focused the current episode when opening a Series without overriding remote input.
- Preserved Calendar's explicit season entry focus when its episode rail finished loading.
- Opened Series Details on the current season and episode, positioned its episode rail, respected thumbnail sizing, and centred Cast & Crew when navigating down.
- Refreshed episode preferences when returning to Series Details and kept ordinary Play from overriding effective audio defaults.
- Remembered Details audio and subtitle choices, including Off and Auto, with confirmation before playback and recovery after uncertain saves; native Apple/Samsung parity remains pending.
- Kept Home rows when a return to Home joined a row-cap read that the previous visit had cancelled.
- Preserved saved logins when entering another server and kept overflowing Accounts actions visible on screen.
- Placed Accounts below the Server heading, matched its section labels and chevrons to Apple TV, and reused the saved account's session when restoring through server entry.
- Matched Accounts spacing, footnote size, chevron symbols and return focus to Apple TV, and kept the profile picker until Remember is chosen even with one unprotected profile.
- Blocked account navigation during removal, guarded legacy sign-ins and released account chooser focus before session recovery.

- Matched Accounts pane rows and Change Account layout, and returned Back from account management to Settings.
- Restored saved-server pane focus, Back from Add server, and pending-removal focus on Samsung TV.
- Preserved the selected account when retiring another session and kept guarded session-only sign-ins usable until restart.
- Kept Change Account reachable when a saved server is offline, prevented removed accounts from being restored by late refreshes, and scrolled account lists to keep remote focus visible.
- Prevented failed replacement sign-ins from restoring old credentials and kept saved-sign-in removal scoped to the selected account.
- Prevented replaced account sessions from overwriting a new sign-in and required fresh PIN proof after committing an account switch.
- Corrected Calendar wall-clock times, spatial shelf return and top restoration, clipped captions, strip placement, and Apple-style loading, empty and error states after native comparison.
- Kept the focus a viewer moved during Calendar's Today request, revealed a day shelf that starts below the page, and spaced day headings at Apple's 595px pitch.
- Down from the Calendar tab opens the selected filter, shelf-to-shelf moves keep the first card's column and bottom-align the day shelf, and scrolled Calendar passes under the top bar.
- Kept collection titles in the server's order, matching Apple TV instead of sorting them alphabetically.
- Lowered the collection Shuffle row, dimmed its heading and count, matched caption spacing, and restored watched badges through profile-aware catalog reads.
- Dimmed collection titles, showed profile poster overlays, kept collection focus rings on artwork, and closed section menus during content loading.
- Matched collection page spacing, Shuffle controls, and truncated poster captions to Apple TV.
- Opened collection pages without requiring catalog totals, showed their item count and Shuffle action, and aligned the Collections grid with Apple TV.

- Displayed Collections as portrait posters with visible missing-artwork placeholders and moved library mode selection into the navigation menu.
- Kept History's focused artwork and captions on screen at every poster size and repainted personal lists when presentation preferences arrived.
- Preserved History's outer posters and focus outlines inside the scroll viewport's horizontal padding.
- Offered an explicit retry when a Favorites continuation failed and the observed end cards could not scroll out of view.
- Resumed personal-list pagination after dismissing card actions that cancelled a pending continuation.
- Restored the For You menu on Down from the retained tab over Watchlist and Favorites, focusing Watchlist as on Apple TV.
- Matched History's Apple TV title position and focused poster scroll clearance.
- Matched Apple TV personal-list loading, root selection, Back navigation, grid spacing, and saved-list ordering.
- Kept saved-list requests and response validation in the shared API adapter and contract modules.
- Kept a Person filter the viewer already chose when a slower availability probe would have removed its chip.
- Moved Up from a Person filmography card to the chip closest to that card's left edge, leaving the card in place when no chip meets it, and scrolled the first row to the page's 72 px bottom padding plus the tvOS safe area.

- Reset fresh Person visits from Search and applied delayed poster and badge preferences on Person.

- Corrected Person safe-area insets, title-count spacing, biography weight, server-driven filters, fresh-visit focus and independent metadata loading, restored catalog status badges, and returned the full hero when focus moved back to its chips.
- Drew the series status TV glyph as Apple's flat `tv` symbol, at that symbol's layout size, and stopped Search from pinning an upward move over the field and filters.
- Drew the TV icon on Returning, Cancelled and Ended badges and raised Home headings by using Skyline's 14px card padding.
- Raised the focused Search poster, darkened the Continue Watching focus shadow, showed the Returning badge on Search cards, and hid the watched tick on Related titles.
- Showed Home rows as soon as they arrived, without waiting on library tabs or an uncapped sections read, and stopped the Home page from saying the server was still waiting. While those rows are still out, Home is an empty page labelled "Loading home" and the library tabs fill in on their own.
- Stopped a delayed Home libraries read from putting a library back after it was hidden in Settings.
- Kept remote navigation when those library tabs arrived on another page, and read them again after the app returned if that read had failed.
- Kept a profile's Movies and Series tabs when a libraries read failed after returning to that profile. A switch to another profile still drops the previous profile's libraries.
- Moved the Home logo slot up to Apple's marquee stack and landed Down from a landscape card on the poster nearest that card.
- Kept the column when moving down between Home rows, and fitted hero title art in Apple's 200px logo slot.
- Down from the top bar lands on the leftmost card instead of the card remembered in the row.
- Matched Apple TV library shelf order and the Recommended, Collections and Browse section menu, keeping Collections in its own destination.
- Restored each page's hero after returning from the profile menu and painted the avatar's white focus ring above its image.
- Renamed the profile menu's Switch Server row to Change Account, after Settings and before Sign Out.

- Matched Apple TV’s fixed top menu and moved Requests into the profile menu.
- Returned focus to the selected tab after leaving profile menu destinations and made the avatar's white focus ring visible over artwork.
- Kept focus on the same top-bar tab when Home rebuilt its library tabs, so hiding a library leaves Profiles focused.
- Matched Apple TV card focus lift, outlines, caption spacing and colours across Search, cast, related titles, Requests and Calendar.
- Kept Search posters at their intended top clearance after the focus lift finished.
- Drew Home TV episode rows as landscape stills and top-aligned the focused Home row with Apple TV.
- Opening a Movies or Series library section, including Continue Watching, no longer sends type, sort and order on the section catalog query, which the server rejected.
- Kept Home hero and detail backdrops sharp using Apple TV artwork sizes instead of small first-pass images.
- Prevented large Search posters from overlapping and kept catalog errors and Try Again visible while People results were pending.
- Restored related titles on Details when the server returned cards without catalog pagination totals.
- Made Enter on the player's default focus skip the intro, recap or credits while the Skip control shows, instead of pausing.
- Kept scrolled personal-list cards visible when pages appended or reads failed.
- Opened History without the top menu, with a centered title, exact counts and Apple's unfiltered 60-item pages.
- Kept personal-list focus and cached cards after failed reads and fitted large History posters to five columns.

### Changed

- Updated FEATURES.md for Apple TV's Change Account and Accounts settings screens: Switch Server and Sign Out & Remove Server are now marked done, and Change Account and Settings › Accounts have their own rows.
- Replaced the README screenshot with For You from a current main build.
- Updated the Series hero and playback target as episode focus moved, added episode air dates and runtimes, restored Apple's fixed detail frames, and resolved local extras whose embedded file ID was absent.

- Updated Movie and Series detail heroes and playback readouts, added Series track selectors and local extras, and aligned episode captions with Apple TV.
- Showed Watchlist, Favorites and History as continuous scrolling grids with Apple TV layouts and empty states.

- Showed the title count, All/Movies/Series filters and paged filmography beneath the Person hero, with one Back returning to the originating credit.
- Matched Apple TV's outlined card focus with a smaller lift, softer captions and a persistent outline on the Series row's current episode.
- Started the horizontal navigation column after leaving a text field, and reset it at the top bar or a page's first card.

- Kept Search's horizontal navigation column through default entries, showed its faded title only on return, and gave posters the native clearance when moving up from Requests.

- Applied Search filters on focus, followed nearby cards on vertical moves, restored native scroll and field presentation, and captioned episodes with their series and episode code.

- Kept focused Search requests visible when People arrived later and retried interrupted Requests refreshes after returning from details.

- Required demonstrated Apple TV parity before merging parity changes, preserved regression checks, and clarified component reuse and simulator ownership for coding agents.
- Added People results, All/Movies/Series filters, result counts, an idle prompt and an independent Available to request rail to Search, and opened Search above its originating page without the root navigation, starting empty on each visit.
- Preset profile avatars showed the flat image Apple TV shows when the server supplied an SVG avatar address.
- Rebuilt Requests to match Apple TV: the hub showed Your requests first with focused title previews, horizontal shelves and Apple's loading, error and empty pages, and no longer had its own Search requests, My Requests, Refresh or Back buttons; details gained posters, backdrops, title metadata, a status tracker and related recommendations, with title fallbacks for missing artwork; and the top bar's tab positions and Search icon used Apple's values. A request or cancellation kept focus on its action while it ran, a refused or unconfirmed one explained itself beside the action, a failed title read showed the full error page, hub rows no longer ended in a See all tile, and a focused poster gained Apple's sheen.
- Combined Calendar week navigation into a compact day strip with release dots and a month label, moved time and status badges onto artwork, and showed instant-backed times in local 12-hour format.
- Played episodes directly from cards and season lists with fresh resume progress, added numbered Play/Resume series actions, and kept episode information available in Card actions.
- Consolidated Details actions into one row, added version and subtitle dialogs, kept rating and personal actions in More, and showed season chips with an inline episode rail and clearer cast and synopsis layouts.
- Settled every unknown Android TV cell in FEATURES.md and added nine parity rows found in the upstream TV parity audits.
- Retried a failed AI subtitle job check up to three times before giving up, and kept the duplicate-job block for a file when switching versions and back.
- Shared Home's Skyline presentation with Library Recommended, replaced heading controls with Explore All tiles, retained usable shelves when collections failed, kept lifted artwork visible when returning between rows, and preserved the current card at grid edges.
- Lifted Library Recommended artwork independently of its captions, with dimmed unfocused labels and a reduced-motion focus ring.
- Started the preceding cast-image fixture explicitly before checking blank Person portraits, avoiding a wait on deferred image loading.
- Rebuilt the profile picker with circular avatars, the signed-in account, Change server and TV profile creation with primary-profile verification, optional PIN and child restrictions.
- Aligned type checks, docs and tests with the Tizen 8.0 minimum (Chromium 108), and named original languages in English with the browser's built-in language names.
- Aligned the top navigation with Apple TV: saved TV menu order, centered Search and roots, anchored menus, profile images, For You shelves, server switching and sign-out confirmation.
- Kept loaded expanded-row cards available when a later page reported the row missing.
- Replaced expanded Home and library row paging with a scrolling catalog that retained loaded cards and focus, followed poster-size preferences, and refreshed changed personal state.
- Aligned Home's backdrop, row and marquee placement, poster-size preferences, artwork resolution, wordmark and control dimensions with the Apple TV source.
- Kept Home available while the optional artwork-capability probe was pending, using small artwork until sizing was known.
- Required Tizen 8.0 or later and targeted its Chromium 108 web engine; TVs on earlier OS versions must upgrade before installing new releases.
- Documented signed-package simulator evidence and Apple TV comparisons.
- Redrew the sign-in screens in the Apple TV layout: Silo wordmark, a drifting brand-light backdrop with grain and the server's accent, glass cards, a server card with its mark and a Secure or HTTP badge, the QR code and code in a card beside the instructions, and the Apple TV wording for every code state; Back now waits while a server connects.
- Sign-in codes now behave as on the Apple TV app: an expired, withdrawn or lost code renews itself for an hour and then pauses until asked, a failing start retries on its own, "Can't reach" and "Too many sign-in attempts" appear only after 10, 30 or 60 seconds of failures, and an approval shows "Signed in as …" for a second before moving on.
- The TV now stops polling a sign-in code while the app is hidden and checks it at once on return (after any wait the server asked for), remembers each server's name, mark and accent between launches, and keeps showing a code through unreadable or unknown poll answers instead of ending sign-in.
- Replaced per-library navigation with Skyline type tabs, anchored library and profile menus, a focus-driven preview and smooth remote scrolling.
- Applied Skyline's OLED palette, typography, focus states and reduced-motion transitions to sign-in, profiles, dialogs and playback, and replaced the blank launcher with Silo artwork.
- Connected native sign-in, profiles, browsing and playback in the packaged app.
- Removed redundant sign-in instructions and movie taglines from the native screens.

### Added

- Kept cached Home, For You and Details content visible without an unreachable notice, matching Apple TV, with private per-profile snapshots and automatic recovery.

- Showed Apple TV's "This server isn't ready" screen when a server still needs setup, with Check again and Change server.
- Added a page linking the silo-apple and silo-android design specs that apply to a TV client, for reading before porting a feature.
- Added the Macroscope visible-change evidence check that silo-apple and silo-android run, tailored to the Samsung TV and its Apple TV comparison.
- Added a CI check that fails when the app or its tests mention an `/api/v1` path, as silo-apple's does.
- Added FEATURES.md, a feature inventory that tracks parity with the Apple TV and Android TV apps, as silo-android's does.
- Added `scripts/sync-apiv2-fixtures.sh`, which re-vendors the API v2 contract fixtures and Settings subset from a silo-server commit, with a test in the CI scripts job.
- Added a weekly Parity drift workflow that opens an issue when the Apple TV or Android TV apps change features since FEATURES.md was last reviewed.
- Added a docs index, a native API v2 reference and a TV focus guide, and grouped the feature, playback and evidence notes into folders as the Apple and Android repositories do.
- Added the top-level files the Silo Apple and Android repositories carry: contributing guide, Samsung store and platform licence exceptions, trademark policy, third-party notices, CLAUDE.md and t3.json, and rewrote the README and agent guide in their layout.
- Added a Promote workflow that turns a tester build into a draft store release with the same `.wgt` and store notes, with a fixed `silo-tizen-latest.wgt` that the `releases/latest` link serves once the store release is published.
- Added a Release workflow that tags a numbered tester build, signs its `.wgt` and publishes it on a GitHub prerelease, plus a fixed "latest tester build" link.
- Added a Tizen Builds CI job that packages the `.wgt` on every pull request and signs it with the maintainer's Samsung certificate on main and same-repository pull requests.
- Added Silo issue forms, contact links, a pull request template, evidence paths, release-note categories and the Discord commit feed, matching the Apple and Android apps.
- Added a separate library Browse grid with continuous loading, sort and filter panels, an A–Z prefix rail, remembered preferences and server-owned Shuffle, while keeping Recommended and the existing library destinations.
- Connected to plain-HTTP Silo servers like the Apple TV app: a typed `http://` address connects directly, and an address without a scheme tries HTTPS first, then asks "Connect without encryption?" before sending anything unencrypted.
- Added "Sign in with a password" beside the sign-in code, as on the Apple TV app; servers without code sign-in open on the password screen, and servers that turned passwords off hide it.
- Added Advanced options to server entry, as on the Apple TV app: choose Auto, HTTPS or HTTP and a port; HTTP connects without asking and HTTPS never falls back to plain HTTP.
- Added capability-gated subtitle translation and audio transcription with quota status, job failures and selectable AI-labeled results.
- Continued series episodes automatically with a cancellable countdown when the server-synced autoplay preference was enabled.
- Added the server-enabled Requests hub, discovery and search, title requests, My Requests, cancellation and follow controls with safe profile changes and return focus.
- Applied profile subtitle appearance and timing to text subtitles and added persistent series subtitle choices, including Off.
- Added a Server pane to Settings with Acknowledgements, crediting TMDB and the other rating sources and listing the open source code in the app.
- Added a timed Skip control for intro, recap and credits during video playback.
- Added a first-selection Remember this profile choice and a device-local launch preference in General Settings, with protected proof restoration and PIN checks for other profiles.
- Added per-profile movie and series star ratings with remote controls, server-confirmed saves and explicit retries.
- Added a person hero that shows a living person's age, initials when there is no photo, and a thumbhash preview while the photo loads.
- Added manual Play next after natural episode completion, with confirmed session teardown, authorized episode resolution, Retry and Back.
- Added Select-hold card actions for watched, favorites and watchlist, with confirmed state, safe explicit retries and restored page focus.
- Added attempt-only preplay audio selection with explicit version binding, fresh Resume and reliable Play from start.
- Added full person filmography with server-filtered All, Movies and Series pages, explicit paging, and restored Details and person focus.
- Added a weekly catalog Calendar with Following, Trending and All filters, release and episode shelves, and context-preserving Details navigation.
- Added Show Title Art and Apply to All Devices in General Settings, with server-confirmed title and season artwork choices and text retained during settings recovery.
- Added episode-aware text Search when the server confirms support, with video-only fallback for older servers and retryable capability failures.
- Added direct single-library menus and fluid library transitions while preserving immediate remote focus and reduced-motion navigation.
- Added separate profile-saved video rewind and fast-forward intervals across player buttons, seek previews and dedicated remote keys.
- Added Home row expansion with bounded pages and direct Continue Watching resume, while omitting featured rows and folding existing recommendations after Continue Watching.
- Added server-provided JPEG thumbnails during seek previews, with timestamp seeking retained when previews are unavailable.
- Added saved profile quality and maximum bitrate controls in Playback Settings, with server-confirmed values and device override visibility.
- Added profile Settings with Hidden libraries and Preferred audio controls.
- Added in-player quality selection from the server's available alternatives, preserving saved quality and bandwidth preferences throughout playback.
- Added visible player transport controls, cancellable seek previews and support for dedicated Samsung media buttons.
- Added profile-scoped Watchlist, Favorites and History pages with bounded pagination, server-side media filters including History episodes, and page and item focus retained on return from Details even after an interrupted page turn.
- Added richer title and season details with artwork, ratings, facts, cast and crew, person pages, related titles, file version selection and server-confirmed personal actions.
- Added Movies and Series library sections, collections, genres, A–Z letter navigation and recently added titles.
- Added strict TypeScript checks and a bundled build.
- Added a native Silo `/api/v2` session core with device-code sign-in, household profiles and PIN checks, and credential storage in Tizen KeyManager.
- Added native sign-in screens for server address entry and device-code sign-in with a QR code, remote-key focus and recovery for each failure.
- Added native household profile screens for choosing and switching profiles, PIN entry with lockout handling, and sign-out.
- Added a native player that plays one file through the server's playback plan with AVPlay, with resume, pause, seeking, progress reporting and a final stop, and recovers from a failed route by asking the server for another one. Full TV playback acceptance remains open.
- Added an audio and subtitles menu to the native player: the server switches the audio track, burns in embedded subtitles or turns them off at the current position, and says plainly when a choice isn't available on this TV. Audible audio changes and visible subtitles are not yet proven on a TV.
- Added native Movies and Series browsing for the selected profile: Home rows, visible libraries in pages, search with the TV keyboard, and movie, series, season and episode pages that hand the chosen file and resume point to the player.
- Added a CI workflow that runs the type checks, the build and all tests.

### Fixed

- Matched Apple TV’s fixed top menu and moved Requests into the profile menu with Back restoring its row.

- Kept a rating write running when the details page restarted, and read the rating only after it settled, so the page shows the stored rating instead of the old one.
- Measured current Continue Watching artwork in geometry regressions without retaining nodes across Home redraws.
- Upgraded cold or incomplete Home artwork after image sizing became available while preserving the selected title, hidden libraries, pending metadata and watched changes from Card actions, including when the optional artwork read failed.
- Preserved mixed-library shortcut scope, open dropdown focus during late menu updates, and unfinished Home metadata reads after visiting For You.
- Made the Browse recovery regression verify every retained title without rejecting valid post-retry prefetch.
- Made the Browse append-failure regression use remote scrolling so a pending focus animation could not undo its setup, and report recovery state if it failed.
- Made the rate-limit sign-in regression await completed server replies before advancing its simulated retry deadlines.
- Kept the blank-portrait regression focused on its own image requests after the preceding cast photo finished loading.
- Allowed sign-in grain artwork and the native AVPlay surface under the TV's content policy while keeping scripts, styles and player objects restricted to the app.
- Made phone/password handoff tests await the approval response before advancing the handoff clock on slower runners.
- Kept Home artwork visible when palette sampling was refused, filled missing marquee metadata from detail, followed regional air dates, and capped shelves at 20 titles with an Explore all tile.
- Kept active password fields and TV keyboards intact when device sign-in became unavailable, updating the phone controls without redrawing the form.
- Preserved the original handoff pause when returning to code sign-in after phone approval instead of starting another code.
- Kept completed phone sign-ins intact when password replies arrived late, and removed saved sign-ins from the protocol and port selected in Advanced options.
- Preserved active password fields and completed sign-in handoffs when provider discovery arrived late, and renewed expired codes after repeated unknown poll responses.
- Made the HTTP badge visibly unlocked, calibrated the cleartext alert's measured frame and translucent surface, and aligned sign-in instruction wrapping and spacing with Apple TV.
- Kept Home metadata current after playback and Home usable when the TV could not save optional presentation caches.
- Home kept the server's profile row order and showed featured rows as ordinary rows, matching Apple TV, instead of moving Continue Watching and recommendations first and hiding featured rows.
- Home's marquee and rows matched Apple TV more closely: series-first episode headlines, rating and file chips, Apple-sized posters and stills, series captions, dimmed captions with an artwork-only focus lift, and watched checks on cards.
- Home showed title logos unless the profile turned title art off, an IMDb or TMDB score in the marquee with TMDB's logo, and the profile's poster badges from its badge settings.
- Home's marquee showed the aired date and billed cast, and Continue Watching showed the file the viewer last played, from detail read once when Home loads.
- Home asked for sharper title logos on servers that take per-slot image widths.
- Restored interrupted playback after connection loss and app return while preserving position, track choices, pause intent and profile authority.
- Kept each library mode's scroll and focus through Details, playback, Settings and interrupted loads, revealed clipped shelf cards on return, and stopped focused cards from growing with reduced motion.
- Preserved episode completion after refused player changes and removed an unusable Retry action when the session expired before completion.
- Removed an unusable Retry action when an episode's playback session expired during final progress reporting, while keeping Back available.
- Synchronized Calendar formatting-recovery tests with the pending weekly response before retrying.
- Refreshed confirmed card-menu values after reopening an unresolved action and preserved Select presses during Details updates.
- Kept preplay audio focus visible, reset changed track selections and rejected incomplete resume responses.
- Corrected the profile PIN regression test to distinguish an unchanged public device ID from retained PIN material while continuing to check all stored values for profile proofs.
- Kept the opening Select hold from activating card actions, prevented concurrent personal updates across Details and card menus, and retained related-card focus during refresh.
- Updated Calendar's Today state at local midnight and refreshed retained weeks after watched, favorites, watchlist and playback changes.
- Preserved the expanded Home row's page and card after playback interrupted a pending page turn.
- Restored playback focus after a media button cancelled a seek preview so the controls could hide again.
- Preserved navigation during slow personal-list loads and refreshed covered personal lists after membership changes in another list.
- Refreshed Home progress after watched changes and made interrupted personal actions retryable when returning to Details.
- Kept synopsis dialogs open during Details updates, refreshed visible and cached episode watched controls after aggregate changes, and enabled watched actions for titles without playback progress.
- Preserved remote focus when library reads finished and kept inline collection cards at their intended width.
- Returned directly between the A–Z grid and its navigation pills while keeping the alphabet rail reachable from the side.
- Cleared invalid pagination cursors so reopening a cached list starts from its first page.
- Kept focus in explicitly opened library menus and revealed the first card when Browse was activated from a scrolled library.
- Restored interrupted library reads, preserved discovery chrome and personal groups, and matched collection cards and grid destinations to Skyline.
- Used the server's section type to keep Continue Watching cards landscape when its section ID is opaque.
- Removed blocking style copies from page transitions and kept menu dismissal from redirecting Search or trapping remote focus.
- Kept dismissed menus closed until reopened deliberately, remembered library scope across launches, and made complete synopses reachable.
- Kept full profile names visible, made empty server fields distinguishable, and supported the Samsung Play/Pause button.
- Kept the exit dialog visible and focused while a screen finished loading.
- Made track-choice buttons activate the same selection as remote Enter.
- Kept playback progress current during track changes and stopped safely when a change's outcome could not be confirmed.
- Kept long audio and subtitle lists inside the player's menu with the focused choice and track status visible.
- Removed the browser placeholder icon from native TV playback.
- Kept the details poster at 2:3 when the description is taller than the poster, instead of stretching it.
- Prevented an old stream from ending playback while a backward seek waited for a replacement plan in the native player.
- Stopped the native player when Silo was backgrounded and preserved codec failures received during a seek.
- Kept playback teardown safe during pending seeks, preserved pause after server re-anchoring, and honored server retry delays in the native player.
- Reloaded an edited search when returning from a result opened before the search delay elapsed.
- Preserved remote focus when a PIN check finished unsuccessfully.
- Kept focus during native profile sign-out and waited for credential cleanup before returning to sign-in.
- Kept manual device-code sign-in available when its link could not be encoded as a QR code.
- Replaced an indefinite connection wait with a retry message while earlier sign-in storage cleanup remained pending.
- Dropped obsolete search responses as soon as the search text changed.

### Security

- Rejected insecure native media URLs and canceled native requests and media-token reads when their account or profile authority changed.
- Revoked native sign-ins abandoned before the sign-in screens handed the account to the app.
- Revoked native refresh credentials received after logout or another sign-in replaced their session.
- Updated the Playwright development dependency from 1.49.0 to 1.64.1 to include the fix for [GHSA-7mvr-c777-76hp](https://github.com/advisories/GHSA-7mvr-c777-76hp), where Playwright's macOS Chrome and Edge install scripts did not verify TLS certificates.
  Playwright runs only the desktop browser checks and is not part of the packaged TV app.
