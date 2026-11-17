# Tizen TV Focus Guidance

This note documents how remote focus works in the Silo Tizen client.
Read it before you change navigation, menus, grids, dialogs or custom controls.
It is the Tizen counterpart of silo-apple's `docs/tvos-focus.md`.

The short version: Tizen has no focus engine for us to lean on.
The app moves focus itself, from `keydown` events, using declared zones.
Every interactive area must have exactly one focus owner.
Do not add a second code path that also moves focus for the same key press.

## Two Focus Hosts

| Host | File | Used by |
| --- | --- | --- |
| `ScreenHost` | `src/ui/screen.ts` | Sign-in, profile picker, PIN, startup and status screens, `playback-unavailable` |
| `FocusHost` | `src/ui/browseFocus.ts` | Browse (Home, libraries, Details, Search, Calendar, Requests), Settings, pickers |

A third owner, the player, handles its own keys (see "Player Keys").

`ScreenHost` shows one screen as a single ordered list of controls.
`FocusHost` shows a view as a stack of zones, which suits shelves, grids and stacked rows.
Both listen on `document` for `keydown` and both bring lost focus back on any remote key except Back, which they handle first.
Use `ScreenHost` for simple forms and button screens, and `FocusHost` for anything two-dimensional.

## Zone Model (`FocusHost`)

A `View` declares `zones`, ordered top to bottom.
Each `Zone` has:

- `id`: stable name such as `nav`, `grid`, `section:<id>`, `controls`.
- `layout`: `"row"` (Left/Right move), `"column"` (Up/Down move) or `"grid"` (both, `columns` items per row).
- `items`: `FocusItem[]`, each with a `key` that is stable within the zone (a content id, not an index) and an `element`.
- Optional `up`, `down`, `left`, `right`: the id of the zone to jump to when a key runs past the zone's edge.
  Naming the zone itself holds the key at the edge; without a link, Up and Down fall through to the neighbouring zone in order. Settings rows hold Up and Down this way.
- Optional `entry`: the item key to land on when another zone is entered by Up/Down (the nav zone uses the selected root).
- Optional `skipDisabled`: Up and Down pass over `aria-disabled` items, as tvOS focus passes a disabled `Button`; with none enabled left that way the key reaches the zone's edge.
  A focused item that becomes disabled keeps focus.
  Settings rows use it, except while a save is in flight.
- Optional `onLeft`: replaces Left entirely for that zone (used for panels that close on Left).
- Optional `reading`: a single reading stop taller than the page (audiobook About).
  Entering it shows its leading edge; Up and Down scroll the page 360 px at a time until that edge is visible, and only then leave the zone.

A key press resolves in this order (`FocusHost.onKey`, `moveWithin`):

1. Find the focused item with `locate(document.activeElement)`.
2. Move inside the zone with `moveWithin`.
   A grid's partly filled last row is still "below": Down lands on its last item.
3. At the zone edge, follow the explicit link (`zone.up`, `zone.down`, ...) if it names a zone that has items.
   The destination item is its explicit `entry`, then the one last focused there, else its first item.
4. With no explicit link, Up and Down fall through to `enterZone`, the nearest zone above or below that has items.
   It lands on `entry`, then the remembered item, then the first item.
   Left and Right never cross zones unless a link or `onLeft` says so.

Rules that follow from this:

- A zone with zero items is skipped, never focused.
- Self-links (`up: "panel"`) trap focus inside a modal zone.
  `libraryBrowseViews.ts` does this for the sort panel and the shuffle alert.
- Text inputs keep Left/Right for the caret: `FocusHost.onKey` returns early when an `HTMLInputElement` has focus and the key is Left or Right.

## Declaring Zones and Initial Focus

A view returns `{ name, content, zones, focus, back }`.

- `content` is the DOM to show.
  `place()` reuses nodes already in position, so the focused node is not recreated on a repaint.
- `zones` list the items in remote order.
- `focus` is the `{ zone, key }` to focus when the view first appears or the requested item is gone.
- `back` is the Back handler (see "Back Handling").

Examples to copy:

- `homeView` in `src/ui/browseViews.ts`: one `row` zone per shelf, id `section:<id>`, focus on the first card, or on `{ zone: "nav", key: "home" }` when there are no cards.
- `statusView` in the same file: loading, failure and empty pages always carry at least one button in a `status` zone, so the page still has a focus target.
- Root screens are wrapped by `Skyline.decorate` (`src/ui/skyline.ts`), which prepends the `nav` row (Search, roots, avatar), plus `selector` and `flyout` zones while those menus are open.
  While the Sign Out confirmation is open, only the `selector` zone is kept and the bar and page are made `inert`.

A `ScreenHost` screen is `{ name, content, controls, focus, back }`.
Controls with a `row` number form a grid: set `row` on every control or on none.
`landing` marks where entering a row lands, and `done` redirects the TV keyboard's Done key (see `pinScreen.ts` and `signIn.ts`).

## Restoring Focus

Focus is always restored by zone id plus item key, never by list position.

- Re-showing a view with the same name keeps the focused item.
  `FocusHost.show` reads `locate(document.activeElement)` before replacing content, then refocuses that `{ zone, key }` in the new view.
  `ScreenHost.show` does the same by control `key`.
- Pushing a route stores `current.focus = host.focused()` (`push` in `src/ui/browse.ts`).
  `pop` calls `showRoute(current, current.focus)`, so Back lands on the card that opened the page.
  The same happens after playback (`resumeAfterPlayback`) and after Settings closes.
- `FocusHost` keeps a per-view "visit" snapshot: remembered item per zone, last zone, vertical scroll and each shelf's horizontal scroll.
  `show` saves it for the view being left and applies it when the view is entered again.
  Library views key their visit by library, type and mode (`visitKey`).
  Details and audiobook routes supply a distinct `View.visitKey` per presentation, retained through loading and repainting and when returning from children.
  A route that leaves the stack for good (popped, replaced by a tab switch or Settings exit) drops those snapshots with `forgetPresentation`; a covered route keeps them for Back.
  Two presentations of the same title therefore retain independent focus and scroll.
- `holdVisit()` saves the visit before chrome is hidden for Settings or playback, because hiding chrome can resize and clamp the viewport.
- `focusDefault()` is for deliberate entry into content (for example leaving the nav bar).
  For `library:<id>` views it prefers the last non-chrome zone of the saved visit; every other view goes straight to `view.focus`.
- Details hero actions use `Zone.restoreEntry` to return to the last enabled action when entering from below, including Up from season pills.
  When that action disappeared (such as Start Over) or a selector is disabled, entry falls back to the current Play/Resume action, then Watchlist if no Play exists.
  Each selector and More retain their own action key; closing a picker or More restores its trigger through the existing modal return path.
- Opening series Details holds focus on the passive hero while its initial episode list loads or Play has no resolved episode label, including before loaders start and after an empty episode response.
  Select there does nothing; a faster playback-detail response cannot move entry focus into the action row while the episode list is still pending.
  When the wait ends, that passive target disappears and the existing loaded entry rule takes over.
  Explicit navigation to a season or action during loading still preserves the viewer's choice.
  See [Details entry loading](features/details-actions.md#entry-loading) for the Apple title source and the remaining title-timing difference.

If you change what a card's `key` is, you change what restores.
Keep it the content id.

## When the Focused Item Disappears

`FocusHost.focusFirst` tries, in order:

1. The explicit `focus` request, if that item still exists.
2. The previously focused item, or a "nearby" replacement.
   When a card with a quick action is removed from its zone, the item now at its old index (clamped to the zone length) takes focus.
3. The remembered item for a restored visit.
4. `view.focus`.
5. If none of those items exist, the first item of the first of those zones that remains.
6. Otherwise the first item of the first non-empty zone anywhere.

Focus therefore moves only when the focused item is gone.
Nothing in the host moves focus for any other reason.
If no zone has any item, nothing is focused: the view must supply a button.
Treat an inert page as a bug.

## How Keys Reach Modals

Modals do not rely on the screen underneath ignoring a key.
They intercept it first, in an earlier phase of the DOM event path.

| Order | Listener | Phase | Behaviour |
| --- | --- | --- | --- |
| 0 | Select release (`selectRelease.ts`) | `window`, capture | Draws the focused button pressed on a fresh Enter and ends the press on any other key or on Enter's release. It never stops a key. |
| 1 | Exit dialog (`exitDialog.ts`) | `window`, capture | Handles every remote key, then `preventDefault` and `stopImmediatePropagation`. Enter runs the focused button on its `keyup`. A `focusin` trap pulls focus back inside. |
| 2 | `FocusHost.onPress` | `document`, capture | Enter only, for cards with a quick action (hold). Registered when browse starts, so it runs before card actions. |
| 3 | Card actions (`cardActions.ts`) | `document`, capture | Registered while its menu or failure alert is open. Up and Down move through the single column, Left and Right stay put, a fresh Enter chooses on its release, Back closes; then `stopImmediatePropagation`. |
| 4 | `Skyline.onKey` | container, capture | Menus, dwell panels, Down into a panel, Back inside the shell. |
| 4 | Settings (`settings.ts`) | container, capture | Left to the categories and the credits scroll. |
| 6 | `FocusHost.onKey`, `ScreenHost.onKey`, player `onKey` | `document`, bubble | Ordinary movement. `FocusHost` returns at once if `event.defaultPrevented`. |
| 7 | App `onBack` (`src/app.ts`) | `window`, bubble | Opens the Exit dialog on an unhandled Back. |
| 8 | Select release (`selectRelease.ts`) | `window`, bubble | Takes the browser's click from an Enter no earlier listener prevented, and clicks the same button on Enter's `keyup`. |

`app.test.ts` asserts the result: with the Exit dialog open, Down and Right send no requests and do not move browse focus.

When you add a modal:

- Intercept in capture phase, call `stopImmediatePropagation`, and give it its own focus owner.
- Trap focus inside it.
- Restore the previous element on close, as `exitDialog.ts` does with `previous`.
- Make the page behind it `inert` and `aria-hidden`, or give the host a zones list that only contains the modal (as the Sign Out confirmation does).
- Skip browse re-renders while it is open (`render` in `browse.ts` returns early when `cardActions.active`).

## Back Handling

Back is code `10009` on a Samsung remote and `Escape` on a desktop keyboard (`src/ui/keys.ts`).
Each layer either handles Back and calls `preventDefault`, or leaves it alone so the next layer sees it.
`FocusHost` honours a `back()` that returns `false` as "not handled".

For browse roots the chain is (`Skyline.back`, `Skyline.onKey`):

1. An open menu (library selector, flyout, profile menu or Sign Out confirmation) closes.
   Focus returns to the anchoring bar item, and the menu stays dismissed until focus leaves that anchor or the viewer presses Down again.
2. Focus inside content moves to the selected tab in the navigation bar.
3. Focus on the bar, on any root other than Home, switches to Home.
4. Focus on the bar at Home, on Search, another tab or the avatar, moves to the Home tab (`handleExitPress`).
5. Focus on the Home tab at Home: `back()` returns `false`, nothing prevents the event, and `app.ts` opens the Exit dialog.

Other layers:

- Pushed pages (Details, Person, Season, Search results and so on) set `back` to `pop`, which restores the route below and its focus.
  Search keeps its own `back` instead of the shell's.
- Library genre views and personal lists pass `pop` to `Skyline.decorate` as `routeBack`, which wins over the bar logic when no menu is open.
- A modal view in browse mode replaces `back` with its own dismiss handler.
- A `ScreenHost` screen with `back: undefined` lets Back reach the app's handler, so sign-in's first screen opens the Exit dialog.
- A no-op handler (`back: () => undefined` while a probe runs in `signIn.ts`) swallows Back deliberately.
- The Exit dialog defaults to Cancel; Back cancels, Select released on Exit calls `options.exit` (`tizen.application` exit in `src/platform.ts`).

## Samsung Remote Specifics

- The remote delivers arrows, Enter and Back as plain `keydown` events.
  The code maps them from `keyCode` first, then `key` (`remoteKey` in `keys.ts`).
  No handler depends on `keypress`, `Tab` or a pointer.
- There is no Tab key on the remote.
  Do not rely on browser tab order or spatial navigation.
  The browser's own movement can fire a second move in grids, which is why hosts call `preventDefault` on every arrow they handle.
  Every control must be reachable by arrows alone.
- Enter is delivered on every remote without registration, as `keydown` and `keyup`.
- Select acts on release, as on tvOS: the focused control runs when Enter is released.
  `selectRelease.ts` marks the held control `data-pressed`.
  Controls with an Apple pressed look are cards, For You and profile menu rows, rail letters, Details pill and circle actions, PIN keys, Change Account rail rows and account cards, profile tiles (including Add), profile picker footer actions, Create Profile's Create, Cancel, Shuffle avatars and library Retry buttons, Settings rail and pane rows, server management rows, Acknowledgements Done, Watch Party's Party options rows, Request detail and Watch Party pill buttons, Series season pills, anchored episode cards and Details popover rows.
  Settings-style rows grow to `1.012` on focus with `120ms ease-out`, then snap to `0.98` while Select is held and snap back when the press ends; only focus changes animate.
  These values match [TVSettingsComponents.swift:208,214,272,279](https://github.com/Silo-Server/silo-apple/blob/08ff656ff2c35bca13f40901cfe9ed83b8f84d7e/iosApp/iosApp/tvOS/Screens/Settings/TVSettingsComponents.swift#L208) and [Theme/SiloTheme.swift:164](https://github.com/Silo-Server/silo-apple/blob/08ff656ff2c35bca13f40901cfe9ed83b8f84d7e/iosApp/iosApp/Theme/SiloTheme.swift#L164) at silo-apple `08ff656ff2c35bca13f40901cfe9ed83b8f84d7e`.
  Reduced motion removes the focus animation.
  Every other control looks unchanged while held until its Apple pressed look is matched.
  `selectRelease.ts` takes Chromium's keydown click from a focused `<button>` or link and clicks it on `keyup` instead, only when focus has not moved.
  Until Enter's keyup, every Enter keydown belongs to the press already down, flagged as a repeat or not (`isFreshSelect`); after a window blur or hidden page the keyup may be lost, so the next Enter starts a new press.
  Auto-repeat never clicks again, and any other key, focus leaving the button, a window blur or a hidden page cancels the press.
  A browse repaint that replaces the held button with the same item's new one keeps the press (`FocusHost.show`).
  A press on a control marked `aria-disabled` never arms, so it never runs, even if a redraw enables that control before release.
  A press whose control is disabled by release time, or repainted as a disabled control, runs nothing either.
  The player checks the same rule for every button it presses, and cancels a held press when a prompt, mode or skip target changes before release.
  An overlay that closes while Select is down (card menu, request menu, Exit dialog, player) calls `swallowSelect()`, so the rest of that press, its repeats and its release, cannot reach what takes focus next; a new press goes through.
  `FocusHost` starts a hold only on a fresh press on an enabled card, and a card disabled before its hold completes or before release runs nothing.
  `ScreenHost` and `FocusHost` leave Enter to it, except for cards with a `quickAction` (see below).
  Menus, the Exit dialog and the player own Enter themselves and also act on its release.
  The Exit dialog, the request menu and the card menu run a button only when `releasedSelect()` names it: the button the press was made on, still focused and enabled, with the press never cancelled.
  A card menu redraw hands a held press to the redrawn row with `moveSelect`.
  A text field keeps the TV keyboard's own Enter.
- Media keys are registered at startup in `registerMediaKeys` (`src/platform.ts`).
  It registers Play/Pause, Play, Pause, Stop, Rewind and Fast Forward one at a time, only if the TV lists them as supported, and a refusal does not stop the others.
  Add any new remote key to `BY_CODE`/`BY_NAME` in `keys.ts` and, if it needs registration, to that list.
- The on-screen keyboard's Done and Cancel arrive as `ime_done` (65376) and `ime_cancel` (65385).
  Down and Done advance a form; search treats Done as "search now" and moves focus to the selected filter, where Apple TV lands when focus leaves its keyboard.
  While the Samsung keyboard is up it shrinks the visual viewport (`innerHeight` 568 on the S95C) but not the layout viewport, so media queries never see it; a `visualViewport` and `window` resize listener sets `search-keyboard-up` when the visible height is at most 824 px (halfway between the open 568 and closed 1080, so the 1079 px frames while the keyboard closes do not count), and Search uses silo-android's keyboard-up header instead of Apple's layout (platform constraint, #533): left-aligned filter chips 16 px under the field, results 16 px under them. Cancel (the remote's Back with the keyboard up) closes the keyboard and stays on Search.
- `config.xml` sets `hwkey-event="enable"` and the `tv.inputdevice` privilege.
- Hold-to-act: `FocusHost` turns a 650 ms Enter hold on a card into its quick action (`SELECT_HOLD_MS`).
  A quick press clicks on key release.
  The press is cancelled when focus, visibility or the element changes.
  The 650 ms value is marked "tune on TV" in the code.

## Never Fetch on Focus

Search filter pills apply their filter immediately, matching Apple TV's segmented picker, and cancel superseded reads.
Series season pills activate after 70 ms of resting focus, matching `TVSeriesDetailView.swift:780–793` at `7baff3ef657757cc0a69202e86dd4bd5c7fcb585` (paths below are under `iosApp/iosApp/tvOS/Screens/Detail/`).
Already loaded seasons select without a read or neighbour warming.
For a missing season, the dwell permits one bounded episode-page read; leaving cancels the wait and any pill-owned read, and revisiting a cancelled or failed read never retries automatically.
Select remains immediate; Retry is the explicit recovery action.
The pill nodes stay mounted during episode updates so repainting cannot cancel their focus or request.
The selected pill centers on initial display and selection, clamped to the row ends, following `TVSeriesDetailView.swift:653–674`.
The signed same-state comparison on 5 November 2026 at `93a39b3` confirmed the pill window; the later inset and hero corrections still need signed comparison.
The current season keeps its current episode on focus, while a different season starts at E01 and retains pill focus until Down.
Episode-card focus paints the loaded summary immediately, then reads missing full detail after 120 ms on the same episode, matching `TVItemDetailView.swift:805-858` at Apple source `df891d2e`.
This is an explicit exception to the general no-focus-fetch rule, approved for Apple TV parity.
The read leaves first and the loading readout repaints on the next animation frame, as Apple's `TVItemDetailView.swift:1012-1023` at `9ff49dca` starts its reads right after the 120 ms sleep; a synchronous Details repaint takes 140–180 ms on the S95C and used to hold the read back.
Cached episodes need no read; leaving before the dwell cancels it.
The existing queue runs at most four detail reads, drops superseded queued focus reads, and keeps failures for explicit Retry rather than retrying on focus.
Uncached playback and version/audio/subtitle activation resolve the selected episode's extra details explicitly.
Answers that reach Details with no key or focus move since the last render, such as seasons, episodes, related titles, personal lists and preferences, repaint once on the next animation frame (`detailsChanged` in `src/ui/browse.ts`).
A burst of answers then costs one render instead of one each, as SwiftUI commits one view update per frame; one render takes 130–180 ms on the S95C.
A change that follows a key or focus move still repaints at once, and a key first draws any pending repaint, so it acts on the screen as shown.
Crossing into a loaded season in the Series rail only selects its cached page; it starts no reads.
Initial row loading, every selected-season change (chip dwell or Select) and a reappearing Details restart the neighbour prefetch and warm the neighbouring episode window; plain focus moves and selected-season Retry do not.
The narrow rail exception is focus resting for 70 ms on an outer loaded edge with a missing neighbour: it requests that one season once per edge, without stacking pending reads or chaining further reads.
An empty response consumes that edge's automatic read; a season-pill activation can load beyond it.
If a successful page is later evicted by the bounded cache, reaching its edge or resting on its season pill can load that page again.
Leaving the card before the dwell ends cancels the request before it starts.
This preserves continuous navigation without loading every season up front.
At Apple source revision `7baff3ef`, `TVItemDetailView.swift:462–466,927–1001` warms neighbours when the selected season changes; `TVEpisodeRail.swift:303–314,450–454` reports focus at the loaded window's first or last card.
Each side stops once it holds eight episodes (`SeriesEpisodeWindow.minimumEpisodesPerSide`), so a selection beside a full side reads nothing there.
A failed neighbour shows only "Couldn't load more episodes. Move away and back to retry." with no button (`TVSeriesDetailView.swift:590–592`); moving away and back to the edge is the retry (`TVItemDetailView.swift:297–300`).
Choosing another season (chip dwell or Select) or reopening Details, including Back to a cached Details, restarts Apple's prefetch (`TVItemDetailView.swift:467,935`).
It clears every edge failure and reads each missing neighbour of the selected season at once, cache first, without a focus move.
Tizen does the same through `warmNeighbors()`, and, as Apple cancels its previous prefetch task, drops neighbour reads still in flight so a late failure cannot show.
A failed season beyond a side that already holds eight episodes is cleared and is not read until focus reaches its edge.
A season the user selected keeps its own failure.
Ordinary loaded-card movement never retries a read.
Translation polls publish the selected season without restarting neighbour reads or clearing a failed edge, following `ItemDetailViewModel.swift:1752–1773` at the same Apple source revision.
Person's grid also loads another page when scrolling reveals a cell within the final eight rows, matching Apple's tvOS grid; card focus handlers do not fetch.
Featured cards are another exception. In the server's auto mode, the marquee starts a description translation only after that card has held the preview for 1500 ms, matching Apple TV's featured-card dwell. Moving on before then starts nothing. Details translation starts with the page. Focusing another episode does not.

The marquee rest is another exception. After focus has stayed on one card for 150 ms, Home, For You and library Recommended read that card's item detail once. The 150 ms value is `SiloTheme.Skyline.marqueeRestDebounceMilliseconds` in silo-apple `2ef3a171`, applied by `TVFocusMarquee.waitForEnrichmentRest` (`TVFocusMarquee.swift:966-971` and `:1028-1049`). A cached answer fills the marquee immediately and does not read again. Moving to another card before the delay, or before the answer lands, cancels the wait and the read, and the late answer cannot change the marquee. A row change is the one case without the wait: when the row band starts scrolling, the new card's read starts at once, as Apple's `restForRowChange` does with `deferNetwork: false` (silo-apple `85679e7` `TVFocusMarquee.swift:818-826`, `:898-904`). A newer focus still cancels it. Continue Watching reads those saved files when its row loads, four at a time. Apple starts one read when `EpisodeThumbCard` mounts (`EpisodeThumbCard.swift:108-110`) inside the row's `LazyHStack` (`MediaRow.swift:413-416`). This row draws every card, so the same reads stay on a queue of four. For You additionally warms at most two rows of eight cards that omit a content rating, three at a time (`RecommendationsView.swift:159-182`). Home does not warm item detail for the other rows; Apple's Home prefetch warms image bytes already in the section payload, at most 40 URLs.

Outside the named filter, season-pill, episode-detail, outer-edge, featured-card and marquee-rest exceptions, moving focus never starts a request, activates a route or writes data.
Fetching belongs to explicit activation (Enter), to a view loading, or to a one-off prefetch.

- Card focus calls `context.preview`, which redraws the marquee from data already in memory (`Skyline.preview`).
  The text follows focus at once; the backdrop waits for focus to rest 150 ms, or after a row change until Apple's 320 ms hold cap, then crossfades for 240 ms.
  The marquee-rest exception above is the only read that preview starts.
- The aired-date and cast line fills in when that rested read lands (`docs/features/skyline-browse-shell.md`, Home section).
- Bar items open a dropdown after a 250 ms dwell on focus.
  The dropdown is passive: it reads nothing and commits only on Enter.
  Down enters it.
- The library flyout appears 150 ms after a library row is focused and reads nothing.
- Settings category focus only previews loaded controls; requests and writes need activation.

## Change Account and Profiles pressed looks

These values were checked against upstream `Silo-Server/silo-apple` main at `1d4b6248f86766b616312ececcee37912886ab51`.
The Change Account view is entirely inside `#if os(tvOS)`; the profile picker uses `TVProfileTile` and the shared button styles through its tvOS branches.

| Controls | Focus | Held Select | Apple source at that revision |
| --- | --- | --- | --- |
| Change Account server rows and Add server | Scale 1; colours ease out over 120 ms | Scale 0.98, snapped | [TVChangeAccountView.swift:309–331](https://github.com/Silo-Server/silo-apple/blob/1d4b6248f86766b616312ececcee37912886ab51/iosApp/iosApp/tvOS/Screens/Auth/TVChangeAccountView.swift#L309-L331) |
| Change Account account cards and Add account | Scale 1.03; ease out over 120 ms | Scale 0.98 replaces the focus scale, snapped | [TVChangeAccountView.swift:306,343–369](https://github.com/Silo-Server/silo-apple/blob/1d4b6248f86766b616312ececcee37912886ab51/iosApp/iosApp/tvOS/Screens/Auth/TVChangeAccountView.swift#L306-L369) |
| Profile tiles and Add | Avatar scale 1.12; focus spring response 0.32, damping 0.72 | Whole tile opacity 0.8, snapped; focus scale stays | [ProfileTile.swift:29–36,116–120,239–243,298–312](https://github.com/Silo-Server/silo-apple/blob/1d4b6248f86766b616312ececcee37912886ab51/iosApp/iosApp/Screens/Profiles/ProfileTile.swift#L29-L36), [focus and style](https://github.com/Silo-Server/silo-apple/blob/1d4b6248f86766b616312ececcee37912886ab51/iosApp/iosApp/Screens/Profiles/ProfileTile.swift#L116-L120), [pressed](https://github.com/Silo-Server/silo-apple/blob/1d4b6248f86766b616312ececcee37912886ab51/iosApp/iosApp/Screens/Profiles/ProfileTile.swift#L239-L243), [Add](https://github.com/Silo-Server/silo-apple/blob/1d4b6248f86766b616312ececcee37912886ab51/iosApp/iosApp/Screens/Profiles/ProfileTile.swift#L298-L312) |
| Profile picker Change account and Sign out | Scale 1.06; focus spring | Opacity 0.7, snapped | [MarqueeControls.swift:137–143](https://github.com/Silo-Server/silo-apple/blob/1d4b6248f86766b616312ececcee37912886ab51/iosApp/iosApp/DesignSystem/Marquee/MarqueeControls.swift#L137-L143), [tvOS footer callers](https://github.com/Silo-Server/silo-apple/blob/1d4b6248f86766b616312ececcee37912886ab51/iosApp/iosApp/Screens/Profiles/ProfileSelectionView.swift#L410-L469) |
| Create Profile: Create | Scale 1.055; focus spring | Opacity 0.8; ease in/out over 120 ms | [ViewExtensions.swift:444–455](https://github.com/Silo-Server/silo-apple/blob/1d4b6248f86766b616312ececcee37912886ab51/iosApp/iosApp/Extensions/ViewExtensions.swift#L444-L455), [caller](https://github.com/Silo-Server/silo-apple/blob/1d4b6248f86766b616312ececcee37912886ab51/iosApp/iosApp/Screens/Profiles/CreateProfileView.swift#L311-L315) |
| Create Profile: Cancel, Shuffle avatars and library Retry | Scale 1.04; ease out over 120 ms | Opacity 0.75, snapped | [SiloButtonStyles.swift:37–62](https://github.com/Silo-Server/silo-apple/blob/1d4b6248f86766b616312ececcee37912886ab51/iosApp/iosApp/Theme/SiloButtonStyles.swift#L37-L62), [tvOS Cancel](https://github.com/Silo-Server/silo-apple/blob/1d4b6248f86766b616312ececcee37912886ab51/iosApp/iosApp/Screens/Profiles/CreateProfileView.swift#L180-L200), [Retry](https://github.com/Silo-Server/silo-apple/blob/1d4b6248f86766b616312ececcee37912886ab51/iosApp/iosApp/Screens/Profiles/CreateProfileView.swift#L545-L558), [Shuffle](https://github.com/Silo-Server/silo-apple/blob/1d4b6248f86766b616312ececcee37912886ab51/iosApp/iosApp/Screens/Profiles/CreateProfileView.swift#L649-L664) |

The shared [SiloTheme.swift:164–173](https://github.com/Silo-Server/silo-apple/blob/1d4b6248f86766b616312ececcee37912886ab51/iosApp/iosApp/Theme/SiloTheme.swift#L164-L173) supplies `fastDuration = 0.12` and `spring(response: 0.35, dampingFraction: 0.85)`.
The footer and primary button reuse the top bar's existing CSS spring approximation: 320 ms with `cubic-bezier(.3,.25,.2,1.02)`.
The profile tiles retain their existing 320 ms CSS focus treatment.
CSS focus curves are approximations, so source values and desktop tests do not establish native motion parity.
Change Account animates a registered focus-scale property separately from its transform, so pressing and releasing snap to the requested scale even during a focus transition.
Create Profile's extra bottom Cancel uses the same ghost style as its header Cancel.
Reduced motion removes transitions and the tile, footer and primary focus growth; the Change Account and ghost-chip scales remain, as in their Apple styles.
`test/ui/accountsParity.test.ts` and `test/ui/profiles.test.ts` render each control focused and held, sample transition timing, and verify one activation on release in both motion modes.
Same-state Samsung TV and Apple TV captures remain a separate acceptance check.

## Pill buttons and Details extras pressed looks

Checked against upstream `Silo-Server/silo-apple` main at `dce56e3c5f0ad137ee8208fb79c7ffd0e9210135`.
Each source file is inside `#if os(tvOS)`, or reaches this control through a tvOS branch.

| Controls | Focus | Held Select | Apple source |
| --- | --- | --- | --- |
| Request detail actions (Request, status, Follow, Cancel) | Scale 1.025 (compact pill) | 0.98 of the focus scale, easeOut 0.12 s | [TVDetailActions.swift:737,745,771,775](https://github.com/Silo-Server/silo-apple/blob/dce56e3c5f0ad137ee8208fb79c7ffd0e9210135/iosApp/iosApp/tvOS/Screens/Detail/TVDetailActions.swift#L737), [RequestDetailView.swift:398](https://github.com/Silo-Server/silo-apple/blob/dce56e3c5f0ad137ee8208fb79c7ffd0e9210135/iosApp/iosApp/Screens/Requests/Detail/RequestDetailView.swift#L398) |
| Watch Party buttons | No scale (`stabilizesFocusMotion`) | 0.98, easeOut 0.12 s | [WatchPartyComponents.swift:389](https://github.com/Silo-Server/silo-apple/blob/dce56e3c5f0ad137ee8208fb79c7ffd0e9210135/iosApp/iosApp/Screens/WatchParty/WatchPartyComponents.swift#L389) |
| Series season pills and the Watch Party picker's | No scale | 0.98, snapped | [TVSeriesDetailView.swift:1291](https://github.com/Silo-Server/silo-apple/blob/dce56e3c5f0ad137ee8208fb79c7ffd0e9210135/iosApp/iosApp/tvOS/Screens/Detail/TVSeriesDetailView.swift#L1291), [WatchPartyMediaPicker.swift:891](https://github.com/Silo-Server/silo-apple/blob/dce56e3c5f0ad137ee8208fb79c7ffd0e9210135/iosApp/iosApp/Screens/WatchParty/WatchPartyMediaPicker.swift#L891) |
| Series episode cards (anchored rail) | Card lift 1.05 | Opacity 0.96, easeOut 0.12 s; the lift stays and the 0.97 art scale of plain cards does not apply | [TVEpisodeRail.swift:477-481,506](https://github.com/Silo-Server/silo-apple/blob/dce56e3c5f0ad137ee8208fb79c7ffd0e9210135/iosApp/iosApp/tvOS/Screens/Detail/TVEpisodeRail.swift#L477-L481), [TVCardFocusStyle.swift:153,158](https://github.com/Silo-Server/silo-apple/blob/dce56e3c5f0ad137ee8208fb79c7ffd0e9210135/iosApp/iosApp/tvOS/Screens/Components/TVCardFocusStyle.swift#L153) |
| Details popover rows | Row highlight | Opacity 0.94, snapped | [TVActionPopoverMenu.swift:128](https://github.com/Silo-Server/silo-apple/blob/dce56e3c5f0ad137ee8208fb79c7ffd0e9210135/iosApp/iosApp/tvOS/Screens/Detail/TVActionPopoverMenu.swift#L128) |

The press scale on pills is the individual CSS `scale` property, so it multiplies the focus `transform` and leaves the focus rules alone.
`SiloTheme.fastDuration` is 0.12 s ([SiloTheme.swift:178](https://github.com/Silo-Server/silo-apple/blob/dce56e3c5f0ad137ee8208fb79c7ffd0e9210135/iosApp/iosApp/Theme/SiloTheme.swift#L178)), which is `--silo-fast`, so Reduce Motion drops the animation and keeps the look.
Request detail's Follow and Cancel pills now grow to 1.025 on focus like the main action, as the same style does on Apple TV.
The Details Play and circle actions already had a press look; player controls, the end-of-playback deck and the Info HUD are still unmatched.
`test/ui/support/pressed.ts` (`assertPressedLook`) renders each control focused and held, in both motion modes, and checks the look, its timing and that a cancelled press runs nothing.
Same-state Samsung TV and Apple TV captures remain a separate acceptance check.

## Reduced Motion

The app honours `prefers-reduced-motion: reduce`.

- `theme.css` sets `--silo-fast` and `--silo-page` to `0ms`.
- `SkylineScroll.move` (`skylineScroll.ts`) sets scroll positions directly instead of animating.
- `FocusHost.show` skips the outgoing-snapshot route transition and clears any running one.
- Focus scale and lift effects have non-animated CSS variants (for example in `browse.css`).

Focus itself and key handling are synchronous in both modes.
Reduced motion changes how things move, never where focus lands or when.
Focus moves use `focus({ preventScroll: true })` and the host scrolls via `SkylineScroll.reveal`, so the browser never scrolls on its own.
Account chooser columns and the Accounts settings list use the same reveal owner to keep focused rows and Add actions visible.
(`ScreenHost` uses a plain `focus()`.)

## Right to Left

Remote keys are physical.
In Arabic the document is `dir="rtl"` ([translation.md](translation.md#right-to-left)) and `remoteKey` (`src/ui/keys.ts`) swaps Left and Right when the element that received the key is in an rtl layout (a view pinned `dir="ltr"` is not), as silo-apple's `MoveCommandDirection.inLayout` does, so `moveWithin`, `onLeft`, the menu flyout and Settings' panes keep their meaning on the mirrored screen: "left" is toward the start of the row, and "right" is past its end.
Write new handlers in layout terms and never swap a key yourself.
Code that must follow the remote's physical side, as the player's transport does, reads `physicalKey`.
A horizontal scroll that sets `scrollLeft` handles a negative `scrollLeft` in a right-to-left row (`SkylineScroll.reveal`, `seasonOffset` and `episodeOffset` do: they return 0 to -range in an rtl row).

### Physical-x geometry audit

Swept once for #605 (`rg "getBoundingClientRect\(\)\.(left|right)|offsetLeft|scrollLeft"` over `src`). A focus or scroll calculation is safe when it compares centres or overlaps (symmetric), writes a physical coordinate it also reads, or branches on `getComputedStyle(row).direction`. Anything that asks "which is past this one" or "how far along" goes through `src/ui/inlineAxis.ts`.

| Where | What it does | Right to left |
| --- | --- | --- |
| `browseFocus` `nearestItem`, `overlappingNearest`, `navigationX`, `centreAt` | nearest by centre x, overlap of two boxes | safe: symmetric |
| `browseFocus` `columnAtOrPastCenter` (Search People to grid) | first column at or past the person's centre | was not safe; now `startsAtOrPast` (`inlineAxis.ts`). Search is pinned left to right today, so it runs the left-to-right branch |
| `browseFocus` aligned landing (`spatial: "aligned"`, Person filmography filters) | the intersecting item closest to the focused item's left edge | was not safe; now `startOffset` (`inlineAxis.ts`). Person pages are pinned left to right today |
| `browseFocus` `intersects`, `insideRow`, `searchRail` clip test | box overlaps a frame | safe: symmetric |
| `browseFocus` row `scrollLeft` snapshot (`visits`, `applyVisit`) | saves and restores a row's scroll | not safe across a direction change; `reconcileLanguage` calls `revealFocused` when the direction flips |
| `skylineScroll` row reveal | physical delta, insets swapped, `Math.min(0, ...)` when rtl | safe |
| `skylineScroll` `seasonOffset`, `episodeOffset`, `prepareEpisodeRow` | stepped Details offsets | safe: rtl branches return 0 to negative range |
| `skylineScroll` `move` | animates `scrollLeft` to a target | safe: takes the target as given |
| `skyline` top-bar `roots` scroll, `panelOrigin`, profile panel and flyout placement | physical delta, transform origin, left or right anchor | safe: physical both ways; the panel and flyout branch on `documentIsRightToLeft` |
| `keys` `remoteKey`, zone `left`/`right` neighbours, `onLeft`, `moveWithin` | Left and Right in layout terms | safe: `remoteKey` swaps by the target's direction |
| Library letter rail (`.browse-letters` and its slide translates) | rail beside the grid | mirrored: on the left in rtl, as Apple does |
| `cardActions` `menuPosition`, `detailsActions` popover `left` | place a menu or popover beside or under its anchor | not focus calculations; physical placement, left unchanged |

One Arabic test per zone in `test/ui/rtl.test.ts`: rows (a row steps and scrolls, and keeps Apple's 80 px end inset), rails (episodes to S02E06, the picked season pill), the letter rail (Browse grid and rail), Search landing, and Settings (Left from the categories enters the rows).

## Player Keys

`src/player/playerScreen.ts` registers its own `document` `keydown` handler and calls `preventDefault` on every remote key, including Back.
It therefore never reaches the app's Exit dialog.
While playback runs, `FocusHost.stop()` has removed browse's key listeners.
Playback has these differences from browse:

- Enter on the scrubber opens a paused timeline selection; another Enter commits it and resumes when playback was running.
  Left and Right preview a seek, Enter commits it and Back cancels it.
  A held direction keeps active playback running.
  With controls visible, Down focuses Play/Pause, and Info and options opens the track menu.
  With controls hidden, Down opens Video when that tab is shown and Info when it is not. Up leaves them hidden, and Left/Right reveals the scrubber and skips.
  Playing controls hide after five seconds from the last interaction, including while a transport button has focus.
- Playback resuming outside the scrubber cancels its timeline preview without seeking and restores auto-hide.
  A hold that paused a pending resume returns that resume on cancellation only if no newer Play or Pause superseded it.
- The track menu opens on the active tab.
  Panes change only on the tab rail, as on Apple TV (`TVPlayerInfoHUD.swift:9-16`): Left/Right on a tab switches panes, Down enters the pane at its top row (Off in Subtitles), Up from a pane's top row returns to its tab, Enter chooses and Back closes.
  Subtitles (TRACKS, OPTIONS) and Video (PLAYBACK, SYNC) have two columns, as Apple's `focusSection` columns: Up and Down stay in the focused column, Left/Right cross to the row level with focus in the other column, and Left/Right past the outer column, or in a one-column pane, do nothing.
  A picker floats over its pane and keeps focus until Back closes it onto the row that opened it; Up at its top does not reach the rail.
- Play/Pause, Play, Pause, Stop, Rewind and Fast Forward act directly.
  Stop leaves playback.
- Back from the overlay leaves playback (`controls.back()`), which restores the originating browse view and focus.
  On the transport buttons Back first returns focus to the overlay, and on Skip it moves focus to Pause (`playerScreen.ts`).
- Completion and error screens have their own button focus rules.

## Checklist

Do:

- Give every view at least one focusable item, including loading, empty and error states.
- Key items by stable content id and declare focus by `{ zone, key }`.
- Use `row`, `column` and `grid` layouts with explicit zone links at real boundaries.
- Let the host call `preventDefault` for arrows it handles.
- Handle Back in exactly one layer, and return `false` when you did not handle it.
- Capture modal keys in capture phase and stop propagation.
- Keep the focused node mounted across repaints.
- Check Reduced Motion on any new animation or scroll.

Don't:

- Don't add `tabindex` navigation, Tab handling or browser spatial navigation.
- Don't move focus programmatically except when the focused item disappears.
  Moving focus in answer to a remote key, including Back to the navigation bar, is the host's job, not a programmatic move.
- Don't restore focus by position or index.
- Don't fetch, write or navigate from `focus` handlers outside the narrow read exceptions above.
- Don't attach a second `keydown` handler that also moves focus in an owned zone.
- Don't let browse render over an active modal.
- Don't infer TV behaviour from desktop Chromium.

## Tests

Run these before and after changing focus code:

```bash
npm run typecheck
npm run test:native      # includes moveWithin in test/native/catalog.test.ts
npm run test:ui          # or one file: node --test --test-timeout=60000 test/ui/focusParity.test.ts
```

Most relevant UI files:

- `test/ui/focusParity.test.ts`: Back keeps committed scroll and shelf position, an offscreen card is revealed on return, library modes keep separate visits, a removed card falls back to a visible title, and Settings, audio, Calendar, Filmography, personal pages and card actions keep visible focus.
  The core cases run in both normal and reduced motion.
- `test/ui/app.test.ts`: root Back opens an isolated Exit dialog; Cancel restores focus; keys do not reach browse; Exit tears down the listener.
- `test/ui/topBar.test.ts` and `test/ui/navigationMotion.test.ts`: dwell, passive dropdowns, Back suppressing reopen, menu updates that keep focus.
- `test/ui/skyline.test.ts`: reduced motion removes screen and focus animation.
- `test/ui/player.test.ts`: transport focus, seek preview, track menu.
- `test/native/platform.test.ts`: media keys register independently.

Desktop Chromium and the fake AVPlay do not prove TV behaviour.
Check D-pad movement, Back and Select hold on a Samsung TV or the Tizen emulator before claiming it works.
See `test/README.md`, `docs/evidence/simulator-evidence.md` and the "TV focus" rules in `AGENTS.md`.

## References

- `AGENTS.md`, "TV focus" and "Playback".
- `docs/features/skyline-browse-shell.md` for the Skyline bar, menus, previews and Settings focus.
- Samsung Remote Control guide: https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html
- Samsung Text-to-Speech / focus guide: https://developer.samsung.com/smarttv/develop/guides/fundamentals/text-to-speech.html
