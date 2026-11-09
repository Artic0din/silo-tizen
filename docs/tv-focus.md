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
- Optional `entry`: the item key to land on when another zone is entered by Up/Down (the nav zone uses the selected root).
- Optional `onLeft`: replaces Left entirely for that zone (used for panels that close on Left).

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
  Details routes supply a distinct `View.visitKey` per presentation, retained through loading and repainting and when returning from children.
  Two presentations of the same title therefore retain independent focus and scroll.
- `holdVisit()` saves the visit before chrome is hidden for Settings or playback, because hiding chrome can resize and clamp the viewport.
- `focusDefault()` is for deliberate entry into content (for example leaving the nav bar).
  For `library:<id>` views it prefers the last non-chrome zone of the saved visit; every other view goes straight to `view.focus`.
- Details hero actions use `Zone.restoreEntry` to return to the last enabled action when entering from below, including Up from season pills.
  When that action disappeared (such as Start Over) or a selector is disabled, entry falls back to the current Play/Resume action, then Watchlist if no Play exists.
  Each selector and More retain their own action key; closing a picker or More restores its trigger through the existing modal return path.

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
| 1 | Exit dialog (`exitDialog.ts`) | `window`, capture | Handles every remote key, then `preventDefault` and `stopImmediatePropagation`. A `focusin` trap pulls focus back inside. |
| 2 | `FocusHost.onPress` | `document`, capture | Enter only, for cards with a quick action (hold). Registered when browse starts, so it runs before card actions. |
| 3 | Card actions (`cardActions.ts`) | `document`, capture | Registered when its menu opens. Handles remote keys and Tab, then `stopImmediatePropagation`. |
| 4 | `Skyline.onKey` | container, capture | Menus, dwell panels, Down into a panel, Back inside the shell. |
| 4 | Settings (`settings.ts`) | container, capture | Left to the categories and the credits scroll. |
| 6 | `FocusHost.onKey`, `ScreenHost.onKey`, player `onKey` | `document`, bubble | Ordinary movement. `FocusHost` returns at once if `event.defaultPrevented`. |
| 7 | App `onBack` (`src/app.ts`) | `window`, bubble | Opens the Exit dialog on an unhandled Back. |

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
4. Focus on the bar at Home: `back()` returns `false`, nothing prevents the event, and `app.ts` opens the Exit dialog.

Other layers:

- Pushed pages (Details, Person, Season, Search results and so on) set `back` to `pop`, which restores the route below and its focus.
  Search keeps its own `back` instead of the shell's.
- Library genre views and personal lists pass `pop` to `Skyline.decorate` as `routeBack`, which wins over the bar logic when no menu is open.
- A modal view in browse mode replaces `back` with its own dismiss handler.
- A `ScreenHost` screen with `back: undefined` lets Back reach the app's handler, so sign-in's first screen opens the Exit dialog.
- A no-op handler (`back: () => undefined` while a probe runs in `signIn.ts`) swallows Back deliberately.
- The Exit dialog defaults to Cancel; Back cancels, Enter on Exit calls `options.exit` (`tizen.application` exit in `src/platform.ts`).

## Samsung Remote Specifics

- The remote delivers arrows, Enter and Back as plain `keydown` events.
  The code maps them from `keyCode` first, then `key` (`remoteKey` in `keys.ts`).
  No handler depends on `keypress`, `Tab` or a pointer.
- There is no Tab key on the remote.
  Do not rely on browser tab order or spatial navigation.
  The browser's own movement can fire a second move in grids, which is why hosts call `preventDefault` on every arrow they handle.
  Every control must be reachable by arrows alone.
- Enter is delivered on every remote without registration.
  `ScreenHost` leaves Enter to the browser: a focused `<button>` gets its `click`, and a text field opens the TV keyboard.
  `FocusHost` also leaves Enter alone, except for cards with a `quickAction` (see below).
- Media keys are registered at startup in `registerMediaKeys` (`src/platform.ts`).
  It registers Play/Pause, Play, Pause, Stop, Rewind and Fast Forward one at a time, only if the TV lists them as supported, and a refusal does not stop the others.
  Add any new remote key to `BY_CODE`/`BY_NAME` in `keys.ts` and, if it needs registration, to that list.
- The on-screen keyboard's Done and Cancel arrive as `ime_done` (65376) and `ime_cancel` (65385).
  Down and Done advance a form; search treats Done as "search now".
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
Cached episodes need no read; leaving before the dwell cancels it.
The existing queue runs at most four detail reads, drops superseded queued focus reads, and keeps failures for explicit Retry rather than retrying on focus.
Uncached playback and version/audio/subtitle activation resolve the selected episode's extra details explicitly.
Crossing into a loaded season in the Series rail only selects its cached page; it starts no reads.
Initial row loading warms the neighbouring episode window; focus activation, Select and selected-season Retry do not.
The narrow rail exception is focus resting for 70 ms on an outer loaded edge with a missing neighbour: it requests that one season once per edge, without stacking pending reads or chaining further reads.
An empty response consumes that edge's automatic read; a season-pill activation can load beyond it.
If a successful page is later evicted by the bounded cache, reaching its edge or resting on its season pill can load that page again.
Leaving the card before the dwell ends cancels the request before it starts.
This preserves continuous navigation without loading every season up front.
At Apple source revision `7baff3ef`, `TVItemDetailView.swift:462–466,927–1001` warms neighbours when the selected season changes; `TVEpisodeRail.swift:303–314,450–454` reports focus at the loaded window's first or last card.
Samsung bounds selection reads more strictly to avoid rate-limited request bursts while retaining the signed comparison's loaded-season behavior.
Apple's failed-edge revisit retries (`TVItemDetailView.swift:297–300`, `TVSeriesDetailView.swift:589–592`); Tizen instead requires the explicit "Retry more episodes" action to protect the rate-limited server.
Neither ordinary loaded-card movement nor revisiting a failed edge retries a read.
Translation polls publish the selected season without restarting neighbour reads or clearing a failed edge, following `ItemDetailViewModel.swift:1752–1773` at the same Apple source revision.
Person's grid also loads another page when scrolling reveals a cell within the final eight rows, matching Apple's tvOS grid; card focus handlers do not fetch.
Featured cards are another exception. In the server's auto mode, the marquee starts a description translation only after that card has held the preview for 1500 ms, matching Apple TV's featured-card dwell. Moving on before then starts nothing. Details translation starts with the page. Focusing another episode does not.

The marquee rest is another exception. After focus has stayed on one card for 150 ms, Home, For You and library Recommended read that card's item detail once. The 150 ms value is `SiloTheme.Skyline.marqueeRestDebounceMilliseconds` in silo-apple `2ef3a171`, applied by `TVFocusMarquee.waitForEnrichmentRest` (`TVFocusMarquee.swift:966-971` and `:1028-1049`). A cached answer fills the marquee immediately and does not read again. Moving to another card before the delay, or before the answer lands, cancels the wait and the read, and the late answer cannot change the marquee. Apple starts this read immediately when the focused row changes (`restForRowChange`, `deferNetwork: false`) so an episode hero can warm; Tizen already has that backdrop on the card, and the same 150 ms wait covers a row change so a run of keys does not send a request per key. Continue Watching reads those saved files when its row loads, four at a time. Apple starts one read when `EpisodeThumbCard` mounts (`EpisodeThumbCard.swift:108-110`) inside the row's `LazyHStack` (`MediaRow.swift:413-416`). This row draws every card, so the same reads stay on a queue of four. For You additionally warms at most two rows of eight cards that omit a content rating, three at a time (`RecommendationsView.swift:159-182`). Home does not warm item detail for the other rows; Apple's Home prefetch warms image bytes already in the section payload, at most 40 URLs.

Outside the named filter, season-pill, episode-detail, outer-edge, featured-card and marquee-rest exceptions, moving focus never starts a request, activates a route or writes data.
Fetching belongs to explicit activation (Enter), to a view loading, or to a one-off prefetch.

- Card focus calls `context.preview`, which redraws the marquee from data already in memory (`Skyline.preview`).
  The first preview is immediate, later ones wait 150 ms and crossfade for 240 ms.
  The marquee-rest exception above is the only read that preview starts.
- The aired-date and cast line fills in when that rested read lands (`docs/features/skyline-browse-shell.md`, Home section).
- Bar items open a dropdown after a 250 ms dwell on focus.
  The dropdown is passive: it reads nothing and commits only on Enter.
  Down enters it.
- The library flyout appears 150 ms after a library row is focused and reads nothing.
- Settings category focus only previews loaded controls; requests and writes need activation.

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
  Down enters its pane, Up at the top returns to its tab, Left/Right switches panes, Enter chooses and Back closes.
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
