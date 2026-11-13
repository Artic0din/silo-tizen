import type { Clock } from "../api/clock.ts";
import type { Card, UserLibrary } from "../contracts/v2/catalog.ts";
import type { PublicStorage } from "../session/deviceIdentity.ts";
import type { FocusItem, FocusTarget, View, Zone } from "./browseFocus.ts";
import { artworkUrl } from "./browseModel.ts";
import { marqueeBadges, marqueeMeta, marqueeRating, marqueeTitle } from "./cardPresentation.ts";
import { actionButton, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";
import { TMDB_LOGO_PATH } from "./acknowledgements.ts";
import { SCROLL_START_EVENT, SkylineScroll } from "./skylineScroll.ts";
import { MARQUEE_REST_MILLISECONDS } from "./homeEnrichment.ts";
import { profileMenuAvatar } from "./navigationAvatar.ts";
import { navigationRoots } from "./navigation.ts";
import type { PrimaryMenu } from "../contracts/v2/navigation.ts";
import { menuIcon } from "./navigationIcon.ts";
import { remoteKey } from "./keys.ts";
import { heroBackdrop, type Tints } from "./heroBackdrop.ts";
import { hidesCardOverview, hidesMarqueeBackdrop, marqueeUsesSeriesArt, type EpisodeSpoilerSettings } from "./episodeSpoilers.ts";
import { DescriptionTranslations, MARQUEE_TRANSLATION_DWELL_MS, marqueeTranslationRequest } from "./descriptionTranslation.ts";
import type { LibraryMode } from "./libraryDiscovery.ts";
import { PERSONAL_TITLES, type PersonalSource } from "./personalLists.ts";
import { signOutConfirmationCopy } from "./signOutConfirmation.ts";

type VideoTab = "movies" | "series" | "music" | "audiobooks";

/** `SiloTheme.Skyline.marqueeCrossfadeDuration` (silo-apple 85679e7 `Theme/SiloTheme.swift:304`). */
const MARQUEE_CROSSFADE_MILLISECONDS = 240;
/** `SiloTheme.Skyline.marqueeBackdropHoldCapMilliseconds` (`Theme/SiloTheme.swift:309`). */
const MARQUEE_BACKDROP_HOLD_CAP_MILLISECONDS = 320;
/** The longest close fade: the sign-out confirmation's easeOut(0.2) (`Components/AccountRemovalConfirmation.swift:34`). */
const PANEL_LEAVE_MILLISECONDS = 200;

interface ProfileMenu {
    readonly requests?: () => void;
    readonly watchParty?: () => void;
    readonly settings?: () => void;
    readonly personal?: (source: PersonalSource, anchor?: "for_you" | "profiles") => void;
    readonly name: string;
    readonly switchProfile: () => void;
    readonly signOut?: () => void;
    readonly switchServer?: () => void;
    readonly serverName?: () => string | undefined;
    readonly accountName?: string;
    readonly lastAccount?: boolean;
}

type RootTarget = "home" | "search" | "calendar" | "for_you" | UserLibrary;

function replaceNodes(container: HTMLElement, nodes: readonly HTMLElement[]): void {
    while (container.firstChild !== null) container.removeChild(container.firstChild);
    for (const node of nodes) container.appendChild(node);
}

function renderMetaLine(card: Card, continuing: boolean): HTMLElement {
    const metaLine = el("div", "skyline-meta-line");
    const rating = card.contentRating?.trim();
    if (rating) metaLine.appendChild(el("span", "skyline-chip", rating.toUpperCase()));
    const meta = marqueeMeta(card, continuing);
    const score = marqueeRating(card);
    if (meta.lead.length > 0 || score !== undefined || meta.trailing.length > 0) {
        // The rating keeps its width; the text around it truncates first (Apple metaText).
        const text = el("span", "skyline-meta");
        const parts: HTMLElement[] = [];
        if (meta.lead.length > 0) parts.push(el("span", "skyline-meta-lead", meta.lead.join(" · ")));
        if (score !== undefined) {
            const entry = el("span", "skyline-rating");
            entry.setAttribute("aria-label", `${score.name} ${score.display}`);
            if (score.name === "TMDB") {
                const logo = el("img", "skyline-rating-logo");
                logo.alt = "";
                logo.src = TMDB_LOGO_PATH;
                entry.append(logo, el("span", "skyline-rating-score", score.display));
            } else entry.append(el("span", "skyline-rating-mark", score.name), el("span", "skyline-rating-score", score.display));
            parts.push(entry);
        }
        if (meta.trailing.length > 0) parts.push(el("span", "skyline-meta-trailing", meta.trailing.join(" · ")));
        parts.forEach((part, index) => { if (index > 0) text.appendChild(el("span", "skyline-meta-dot", " · ")); text.appendChild(part); });
        metaLine.appendChild(text);
    }
    return metaLine;
}

/** Root chrome owns no requests. Only explicit activation changes the route or library. */
export class Skyline {
    private requestsEnabled = false;
    private showAudiobooks = false;
    setRequestsEnabled(enabled: boolean): void {
        if (this.requestsEnabled === enabled) return;
        this.requestsEnabled = enabled;
        if (this.profileOpen) this.rebuildProfile();
        else if (!enabled) this.selector.querySelector('[data-focus="requests"]')?.remove();
    }

    private watchPartyEnabled = false;
    setWatchPartyEnabled(enabled: boolean): void {
        if (this.watchPartyEnabled === enabled) return;
        this.watchPartyEnabled = enabled;
        if (this.profileOpen) this.rebuildProfile();
        else if (!enabled) this.selector.querySelector('[data-focus="watch-party"]')?.remove();
    }

    private routeBack: (() => void) | undefined;
    private readonly nav = el("nav", "browse-nav");
    private readonly tabs = el("div", "skyline-tabs");
    private readonly roots = el("div", "skyline-roots");
    private menu: PrimaryMenu | null = null;
    private navigationIdentity = "";
    private panelAnchor: string | undefined;
    private shortcutSelection: string | undefined;
    private panelLibrary: UserLibrary | undefined;
    private panelTitle = "";
    private confirmation = false;
    private avatarReference: string | undefined;
    private avatarText: string | undefined;
    private readonly tools = el("div", "skyline-tools");
    private readonly selector = el("div", "skyline-selector skyline-panel");
    private readonly marquee = el("div", "skyline-marquee");
    private readonly body = el("div", "skyline-content");
    private readonly scrim = el("div", "skyline-dropdown-scrim");
    private readonly flyout = el("div", "skyline-selector skyline-panel skyline-flyout");
    /** Copies of a closed panel fading out, as Apple's persistent panels do; never focusable or announced. */
    private readonly leaving = el("div", "skyline-leaving");
    private clearLeaving = (): void => undefined;
    /** Where, in the open panel, its scale is anchored: under the tab or avatar centre. */
    private panelOrigin = 0;
    private flyoutItem: FocusItem | undefined;
    private flyoutItems: FocusItem[] = [];
    private libraryRow: FocusItem | undefined;
    private cancelFlyout = (): void => undefined;
    private readonly scroll = new SkylineScroll();
    private libraries: readonly UserLibrary[] = [];
    private items: FocusItem[] = [];
    private panel: FocusItem[] = [];
    private panelTab: VideoTab | undefined;
    private profileOpen = false;
    private dismissedAnchor: string | undefined;
    private cancelDwell = (): void => undefined;
    private previewId: string | undefined;
    /** The marquee's backdrop layer and what it draws; the text layer above it follows focus on its own. */
    private art: HTMLElement | undefined;
    private artKey: string | undefined;
    /** TVRootHeroBackdrop.hasDisplayedArtwork: only artwork after the first crossfades. */
    private artShown = false;
    private cancelRest = (): void => undefined;
    /** The backdrop swap waiting out the 150 ms rest, then one a row scroll holds. */
    private restingBackdrop: (() => void) | undefined;
    private heldBackdrop: (() => void) | undefined;
    /** setBackdropDeferred: a row-change scroll holds the backdrop until its 320 ms cap. */
    private rowScrolling = false;
    private cancelHoldCap = (): void => undefined;
    private readonly tints = new Map<string, Tints>();
    private selected = "home";
    private sharedScene = false;
    private scopes = new Map<VideoTab, string>();
    private visible = false;
    private immediatePreview = true;
    private readonly container: HTMLElement;
    private readonly clock: Clock;
    private readonly activate: (target: RootTarget, mode?: LibraryMode) => void;
    private readonly profiles: ProfileMenu;
    private readonly refresh: (focus?: FocusTarget) => void;
    private readonly storage: PublicStorage | undefined;
    private readonly storageKey: string;
    private readonly baseUrl: string;
    /** Whether the profile's title-art setting lets a logo replace the marquee title. */
    titleArt: () => boolean = () => false;
    /** Profile spoiler switches. Off until browse installs the owner. */
    spoilers: () => EpisodeSpoilerSettings = () => ({ hidesImages: false, hidesOverviews: false });
    filled: (card: Card) => Card = card => card;
    /** A row change starts the focused card's detail read without the 150 ms rest (restForRowChange). */
    rowChangeRead: () => void = () => undefined;
    /** What Home's detail reads added for a title: the aired and cast line, and Continue Watching's saved-file chips. */
    details: (card: Card, continuing: boolean) => { readonly line: string | undefined; readonly badges: readonly string[] | undefined } = () => ({ line: undefined, badges: undefined });
    translations: DescriptionTranslations | undefined;
    private shown: { card: Card; row: string; continuing: boolean; featured: boolean } | undefined;
    /** True while this visit's scene includes the marquee. Calendar and Settings do not. */
    private marqueeShown = false;
    /** True after a dwell is scheduled and until it fires or is cancelled. */
    private translationArmed = false;
    private cancelTranslation = (): void => undefined;

    constructor(
        container: HTMLElement,
        clock: Clock,
        activate: (target: RootTarget, mode?: LibraryMode) => void,
        profiles: ProfileMenu,
        refresh: (focus?: FocusTarget) => void,
        storage: PublicStorage | undefined,
        storageKey: string,
        baseUrl: string,
    ) {
        this.container = container;
        this.clock = clock;
        this.activate = activate;
        this.profiles = profiles;
        this.refresh = refresh;
        this.storage = storage;
        this.storageKey = storageKey;
        this.baseUrl = baseUrl;
        this.nav.setAttribute("aria-label", "Main navigation");
        this.tabs.setAttribute("role", "tablist");
        const wordmark = el("img", "skyline-wordmark");
        wordmark.src = "img/silo-wordmark.png";
        wordmark.alt = "Silo";
        this.nav.append(wordmark, this.tabs, this.tools);
        this.selector.setAttribute("role", "menu");
        this.selector.hidden = true;
        this.scrim.hidden = true;
        this.scrim.addEventListener("click", () => { if (this.confirmation) this.back(); });
        this.flyout.hidden = true;
        this.flyout.setAttribute("role", "menu");
        this.leaving.setAttribute("aria-hidden", "true");
        this.leaving.inert = true;
        this.marquee.setAttribute("aria-live", "polite");
        this.marquee.setAttribute("aria-atomic", "true");
        container.addEventListener("focusin", this.onFocus);
        container.addEventListener("keydown", this.onKey, true);
        this.body.addEventListener(SCROLL_START_EVENT, this.onRowScrollStart);
    }

    update(libraries: readonly UserLibrary[]): void {
        this.libraries = libraries;
        const roots = navigationRoots(this.menu, libraries, this.requestsEnabled, this.showAudiobooks);
        const identity = JSON.stringify(roots);
        if (identity === this.navigationIdentity || !this.selector.hidden) return;
        const focusedKey = this.items.find((item) => item.element === document.activeElement)?.key;
        this.navigationIdentity = identity;
        this.close();
        const rootItems = roots.map(root => {
            const item = actionButton(root.key, root.title, () => {
                if (root.key === "movies" || root.key === "series" || root.key === "music" || root.key === "audiobooks") {
                    const library = this.scope(root.key);
                    if (library !== undefined) this.commit({ ...library, type: root.key });
                } else this.commit(root.key);
            });
            item.element.setAttribute("role", "tab");
            if (root.key === "movies" || root.key === "series" || root.key === "audiobooks" || root.key === "for_you") item.element.setAttribute("aria-haspopup", "menu");
            // topBar.hint.forYou (TVTopMenuBar.swift:484, :501-502).
            if (root.key === "for_you") item.element.setAttribute("aria-description", "Rest to choose Watchlist, Favorites, or Recommendations");
            return item;
        });
        const searchItem = actionButton("search", "", () => this.commit("search"));
        this.items = [searchItem, ...rootItems, actionButton("profiles", this.profiles.name.slice(0, 1).toUpperCase(), () => this.openProfile(true))];
        const search = this.items.find((item) => item.key === "search");
        search?.element.setAttribute("aria-label", "Search");
        search?.element.classList.add("skyline-search");
        const profiles = this.items.find((item) => item.key === "profiles");
        profiles?.element.setAttribute("aria-label", "Profiles");
        profiles?.element.classList.add("skyline-profile");
        profiles?.element.setAttribute("aria-haspopup", "menu");
        replaceNodes(this.roots, rootItems.map(item => item.element));
        const balance = el("span", "skyline-search-balance");
        balance.setAttribute("aria-hidden", "true");
        replaceNodes(this.tabs, [searchItem.element, this.roots, balance]);
        replaceNodes(this.tools, this.items.slice(-1).map(item => item.element));
        // Removing the focused tab moves focus to the next control, the first title. Put the same
        // tab back when it is still in the strip, before that move can be recorded as content focus.
        if (focusedKey !== undefined) this.items.find((item) => item.key === focusedKey)?.element.focus({ preventScroll: true });
    }

    setMenu(menu: PrimaryMenu | null): void { this.menu = menu; this.update(this.libraries); }

    /** The local Show Audiobooks opt-in: the Audiobooks tab appears or goes with it. */
    setShowAudiobooks(show: boolean): void {
        if (this.showAudiobooks === show) return;
        this.showAudiobooks = show;
        this.update(this.libraries);
    }

    private forType(type: VideoTab): readonly UserLibrary[] {
        return this.libraries.filter((library) => library.type === type || (type !== "music" && type !== "audiobooks" && library.type === "mixed"));
    }

    private scope(type: VideoTab): UserLibrary | undefined {
        let id = this.scopes.get(type);
        if (id === undefined) {
            try { id = this.storage?.getItem(`${this.storageKey}:${type}`) ?? undefined; } catch { /* Session scope remains available when storage is blocked. */ }
        }
        return this.forType(type).find((library) => library.id === id) ?? this.forType(type)[0];
    }


    private commit(target: RootTarget, mode?: LibraryMode): void {
        if (!this.visible) return;
        const anchor = this.panelAnchor;
        this.shortcutSelection = typeof target !== "string" && this.panelAnchor?.startsWith("library:") ? this.panelAnchor : undefined;
        if (typeof target !== "string") {
            const type = this.panelTab ?? (target.type === "series" ? "series" : target.type === "music" ? "music" : target.type === "audiobooks" ? "audiobooks" : "movies");
            this.scopes.set(type, target.id);
            try { this.storage?.setItem(`${this.storageKey}:${type}`, target.id); } catch { /* Keep the selection for this session. */ }
        }
        this.close();
        // Loading can briefly restore the tab before content takes focus.
        this.dismissedAnchor = anchor;
        this.cancelDwell();
        this.activate(target, mode);
    }

    setAvatar(name: string, reference: string | undefined, baseUrl: string, text?: string): void {
        this.avatarReference = reference;
        this.avatarText = text;
        const profile = this.items.find(item => item.key === "profiles");
        const identity = JSON.stringify([name, reference, baseUrl, text]);
        if (profile === undefined || (profile.element.firstElementChild as HTMLElement | null)?.dataset.avatarIdentity === identity) return;
        const avatar = profileMenuAvatar(name, reference, text, baseUrl, 58);
        avatar.dataset.avatarIdentity = identity;
        replaceNodes(profile.element, [avatar]);
    }

    decorate(view: View, selected: string, preview: boolean, routeBack?: () => void, libraryKey?: string): View {
        const libraryRoot = selected === "movies" || selected === "series" || selected === "music" || selected === "audiobooks";
        if (libraryRoot && this.shortcutSelection !== undefined && libraryKey?.startsWith(`${this.shortcutSelection}:`)) selected = this.shortcutSelection;
        this.routeBack = routeBack;
        this.visible = true;
        this.marqueeShown = preview;
        // Home to Calendar drops the marquee without hide(). The dwell must not finish off screen.
        if (!preview) this.cancelTranslation();
        if (this.selected !== selected) this.immediatePreview = true;
        this.selected = selected;
        this.sharedScene = preview && (libraryRoot || selected === "home" || selected === "for_you");
        if (preview && libraryRoot && view.focus === undefined) view = { ...view, focus: { zone: "nav", key: selected } };
        for (const item of this.items) {
            const current = item.key === selected ? "page" : "false";
            const previous = item.element.getAttribute("aria-current");
            // TVTopMenuCapsuleChrome: a selection change eases over 0.18 s; a focus change springs. Focusing a tab ends it.
            if (previous !== null && previous !== current && item.element !== document.activeElement) item.element.setAttribute("data-selection-motion", "");
            item.element.setAttribute("aria-current", current);
            if (item.element.getAttribute("role") === "tab") item.element.setAttribute("aria-selected", String(item.key === selected));
        }
        const zones: Zone[] = [{ id: "nav", layout: "row", items: this.items, entry: selected }];
        if (!this.selector.hidden) zones.push({ id: "selector", layout: this.confirmation ? "row" : "column", items: this.panel });
        if (!this.flyout.hidden) zones.push({ id: "flyout", layout: "column", items: this.flyoutItems });
        const prepare = (): void => {
            // FocusHost has saved the viewport before child views move cached nodes.
            view.prepare?.();
            this.container.classList.add("skyline-root");
            this.container.classList.toggle("skyline-preview", preview);
            this.container.classList.toggle("skyline-home", this.sharedScene);
            this.container.classList.toggle("skyline-library", preview && libraryRoot && !this.sharedScene);
            this.container.classList.toggle("skyline-grid", !preview && (libraryRoot || selected === "profiles" || view.name.startsWith("personal:")));
            // Remove replaced siblings first, as FocusHost's place() does, so a retained node (Browse's letter rail) is never moved:
            // a move blurs its focused child and resets its scroll.
            const retained = new Set<Element>(view.content);
            for (const child of Array.from(this.body.children)) if (!retained.has(child)) child.remove();
            view.content.forEach((node, index) => {
                const existing = this.body.children[index];
                if (existing !== node) this.body.insertBefore(node, existing ?? null);
            });
            while (this.body.children.length > view.content.length) this.body.lastElementChild?.remove();
        };
        this.nav.inert = this.confirmation;
        this.body.inert = this.confirmation;
        if (this.confirmation) { this.nav.setAttribute("aria-hidden", "true"); this.body.setAttribute("aria-hidden", "true"); }
        else { this.nav.removeAttribute("aria-hidden"); this.body.removeAttribute("aria-hidden"); }
        if (preview && !this.translationArmed) this.armTranslation();
        return { ...view, prepare, transition: { key: libraryKey ?? selected, group: selected }, content: [this.scrim, this.nav, this.selector, this.flyout, this.leaving, ...(preview ? [this.marquee] : []), this.body], zones: this.confirmation ? zones.filter(zone => zone.id === "selector") : [...zones, ...view.zones], back: selected === "search" ? view.back : () => this.back() };
    }

    hide(): void {
        this.routeBack = undefined;
        this.visible = false;
        this.marqueeShown = false;
        this.close();
        this.clearLeaving();
        this.suspendBackdrop();
        this.cancelTranslation();
        this.container.classList.remove("skyline-root", "skyline-preview", "skyline-library", "skyline-home");
    }

    /** Redraws the shown preview, as when the title-art answer lands. */
    repaint(): void {
        const shown = this.shown;
        if (shown === undefined || this.previewId !== `${shown.row}:${shown.card.id}`) return;
        this.draw(shown.card, shown.row, shown.continuing, shown.featured);
        if (!this.backdropPending()) this.showBackdrop(shown.card, false);
    }

    /** Fills in what a detail read added for the shown title, in place, when its answer lands. */
    refreshDetails(id: string): void {
        const shown = this.shown;
        const layer = this.marquee.querySelector<HTMLElement>(".skyline-marquee-layer:not(.skyline-outgoing)");
        if (shown !== undefined && shown.card.id === id && layer !== null) this.fillDetails(layer, shown.card, shown.continuing);
    }

    private fillDetails(layer: HTMLElement, card: Card, continuing: boolean): void {
        layer.querySelector(".skyline-meta-line")?.replaceWith(renderMetaLine(this.filled(card), continuing));
        const details = this.details(card, continuing);
        const line = layer.querySelector(".skyline-detail-line");
        if (line !== null) {
            let text = line.querySelector(".skyline-detail-text");
            if (text === null) {
                text = el("span", "skyline-detail-text");
                line.appendChild(text);
            }
            text.textContent = details.line ?? "";
        }
        const badges = layer.querySelector(".skyline-badges");
        if (badges !== null) replaceNodes(badges as HTMLElement, (details.badges ?? marqueeBadges(card.overlay)).map(badge => el("span", "skyline-chip", badge)));
    }

    /**
     * TVFocusMarquee.preview (silo-apple 85679e7 `tvOS/Components/TVFocusMarquee.swift:779-816`): the title, meta and
     * synopsis follow focus at once with no animation (`:1249`, `:1262-1264`); only the backdrop waits.
     */
    preview(card: Card, row: string, continuing = false, featured = false): void {
        const identity = `${row}:${card.id}`;
        if (this.previewId === identity && this.shown?.card === card && this.shown.continuing === continuing && this.shown.featured === featured) {
            // hide() cancels the dwell and the backdrop rest and keeps this card. Coming back has to restore both.
            if (!this.translationArmed) this.armTranslation();
            if (!this.backdropPending()) this.showBackdrop(card, false);
            return;
        }
        // Focus owns the dwell immediately; capability/repaint callbacks must not rearm the outgoing card.
        this.cancelTranslation();
        const rowChange = this.shown?.row !== row;
        const cold = this.previewId === undefined || this.immediatePreview;
        this.previewId = identity;
        this.immediatePreview = false;
        this.draw(card, row, continuing, featured);
        this.armTranslation();
        // cancelBackdropWork: a swap still waiting for an earlier card must never land under this one.
        this.dropPendingBackdrop();
        if (cold) {
            // restImmediately: a newly shown feed paints its first backdrop on the first frame.
            this.artShown = false;
            this.showBackdrop(card, false);
            return;
        }
        const swap = (): void => this.showBackdrop(card, true);
        // restForRowChange: a scroll already under way is the gate, so the rest is skipped and the scroll holds the swap.
        if (this.rowScrolling && rowChange) {
            this.restForRowChange(swap);
            return;
        }
        this.restingBackdrop = swap;
        this.cancelRest = this.clock.schedule(() => {
            this.cancelRest = () => undefined;
            this.restingBackdrop = undefined;
            this.holdOrSwap(swap);
        }, MARQUEE_REST_MILLISECONDS);
    }

    private dropPendingBackdrop(): void {
        this.cancelRest();
        this.cancelRest = () => undefined;
        this.restingBackdrop = undefined;
        this.heldBackdrop = undefined;
    }

    private backdropPending(): boolean {
        return this.restingBackdrop !== undefined || this.heldBackdrop !== undefined;
    }

    /** updateBackdropIfReady: while a row scroll holds the backdrop, keep the swap for the hold cap. */
    private holdOrSwap(swap: () => void): void {
        if (this.rowScrolling) { this.heldBackdrop = swap; return; }
        this.heldBackdrop = undefined;
        swap();
    }

    /**
     * restForRowChange (TVFocusMarquee.swift:818-826): restart the hold cap, start the detail read without the rest,
     * and hold the swap.
     */
    private restForRowChange(swap: () => void): void {
        this.armHoldCap();
        this.rowChangeRead();
        this.holdOrSwap(swap);
    }

    /**
     * armBackdropHoldCap (TVFocusMarquee.swift:914-925). Home's band is tvOS's native ScrollView
     * (TVSkylineSectionFeed.swift:159-178), whose scroll phase stays non-idle for over a second after one move
     * (SiloTheme.swift:305-309), so Apple's swap always lands at this cap. Tizen releases at the cap as well, not when
     * its own shorter scroll settles.
     */
    private armHoldCap(): void {
        this.cancelHoldCap();
        this.cancelHoldCap = this.clock.schedule(() => {
            this.cancelHoldCap = () => undefined;
            if (!this.rowScrolling) return;
            this.rowScrolling = false;
            const swap = this.heldBackdrop;
            this.heldBackdrop = undefined;
            swap?.();
        }, MARQUEE_BACKDROP_HOLD_CAP_MILLISECONDS);
    }

    /** setBackdropDeferred(true) (TVFocusMarquee.swift:893-904): the row band started scrolling. */
    private readonly onRowScrollStart = (): void => {
        this.rowScrolling = true;
        const swap = this.restingBackdrop;
        if (swap === undefined) { this.armHoldCap(); return; }
        this.dropPendingBackdrop();
        this.restForRowChange(swap);
    };

    /** TVFocusMarquee.suspend: leaving drops every pending swap and any hold an unfinished scroll left. */
    private suspendBackdrop(): void {
        this.dropPendingBackdrop();
        this.rowScrolling = false;
        this.cancelHoldCap();
    }

    /**
     * TVSkylineBackdrop over TVRootHeroBackdrop (TVSkylineSectionFeed.swift:370-380, TVRootHeroBackdrop.swift:156-205):
     * the same artwork stays put; new artwork fades in over the old with easeInOut(0.24), except the first. The art is
     * AsyncImageView's default `.surface`: the backdrop ThumbHash until the image decodes (TVRootHeroBackdrop.swift:181-186).
     */
    private showBackdrop(card: Card, animate: boolean): void {
        const settings = this.spoilers();
        const seriesArt = marqueeUsesSeriesArt(card, settings);
        const background = hidesMarqueeBackdrop(card, settings) ? undefined : artworkUrl(seriesArt ? card.seriesBackdropUrl : card.backdropUrl, this.baseUrl);
        const thumbhash = seriesArt ? undefined : card.backdropThumbhash;
        const key = JSON.stringify([this.sharedScene, background ?? null, thumbhash ?? null]);
        // A failed image is not kept: the next preview of the same artwork asks for it again.
        if (key === this.artKey && this.art?.dataset.failed === undefined) return;
        const layer = el("div", "skyline-marquee-art");
        layer.setAttribute("aria-hidden", "true");
        if (background !== undefined && this.sharedScene) {
            layer.appendChild(heroBackdrop(background, thumbhash, this.tints, false, true));
        } else if (background !== undefined) {
            const image = el("img", "skyline-backdrop");
            image.alt = "";
            image.referrerPolicy = "no-referrer";
            image.src = background;
            image.addEventListener("error", () => image.remove());
            layer.append(image, el("div", "skyline-scrim"));
        }
        layer.querySelector("img.skyline-backdrop")?.addEventListener("error", () => { layer.dataset.failed = ""; });
        const outgoing = this.art;
        for (const old of Array.from(this.marquee.querySelectorAll(".skyline-marquee-art"))) old.classList.add("skyline-outgoing");
        if (outgoing === undefined) this.marquee.prepend(layer);
        else outgoing.after(layer);
        this.art = layer;
        this.artKey = key;
        this.cancelFade();
        this.cancelFade = () => undefined;
        const fade = animate && this.artShown && outgoing !== undefined;
        if (background !== undefined) this.artShown = true;
        const clear = (): void => { for (const old of Array.from(this.marquee.querySelectorAll(".skyline-marquee-art"))) if (old !== layer) old.remove(); };
        if (!fade) { clear(); return; }
        // An empty layer has nothing to fade in, so the outgoing art fades out instead.
        if (layer.childElementCount > 0) layer.classList.add("skyline-art-enter");
        else outgoing.classList.add("skyline-art-leave");
        this.cancelFade = this.clock.schedule(clear, MARQUEE_CROSSFADE_MILLISECONDS);
    }

    /** Featured cards in auto mode only, after the card has held the marquee. Rolling focus never reaches this. */
    armTranslation(): void {
        this.cancelTranslation();
        const shown = this.shown;
        const translations = this.translations;
        if (!this.marqueeOnScreen() || shown === undefined || translations === undefined) return;
        const pending = translations.cards.presentation(shown.card).pendingLanguage;
        if (marqueeTranslationRequest(shown.featured, translations.onView(), shown.card.id, pending) === undefined) return;
        const card = shown.card;
        this.translationArmed = true;
        const cancel = this.clock.schedule(() => {
            this.translationArmed = false;
            this.cancelTranslation = () => undefined;
            if (!this.marqueeOnScreen() || this.shown?.card !== card) return;
            this.translations?.cards.cardDidAppear(card);
        }, MARQUEE_TRANSLATION_DWELL_MS);
        this.cancelTranslation = () => {
            cancel();
            this.translationArmed = false;
            this.cancelTranslation = () => undefined;
        };
    }

    /** Replaces the synopsis and the status that leads the detail line, without redrawing the marquee. */
    refreshTranslation(target?: HTMLElement): void {
        const shown = this.shown;
        const layer = target ?? this.marquee.querySelector<HTMLElement>(".skyline-marquee-layer:not(.skyline-outgoing)");
        if (shown === undefined || layer === null || this.translations === undefined) return;
        const presentation = this.translations.cards.presentation(shown.card);
        let synopsis = layer.querySelector<HTMLElement>(".skyline-synopsis");
        if (hidesCardOverview(shown.card, this.spoilers())) synopsis?.remove();
        else if (presentation.overview !== undefined && presentation.overview !== "") {
            if (synopsis === null) {
                synopsis = el("p", "skyline-synopsis", presentation.overview);
                layer.querySelector(".skyline-detail-line")?.before(synopsis);
            } else synopsis.textContent = presentation.overview;
            synopsis.classList.toggle("is-translating", presentation.status?.kind === "translating");
        }
        layer.classList.toggle("skyline-translation-visible", presentation.status !== undefined);
        const line = layer.querySelector(".skyline-detail-line");
        if (line === null) return;
        let status = line.querySelector<HTMLElement>(".skyline-translation-status");
        if (presentation.status === undefined) status?.remove();
        else if (status === null) {
            status = el("span", "skyline-translation-status", presentation.status.text);
            status.dataset.translationStatus = presentation.status.kind;
            line.prepend(status);
        } else {
            status.textContent = presentation.status.text;
            status.dataset.translationStatus = presentation.status.kind;
        }
    }

    private draw(card: Card, row: string, continuing: boolean, featured = false): void {
        this.shown = { card, row, continuing, featured };
        // Apple's marquee (TVMarqueeBlock): the row name is spoken, never drawn.
        const layer = el("div", "skyline-marquee-layer");
        const title = el("h1", "skyline-title", marqueeTitle(card));
        layer.append(el("span", "skyline-row-name silo-sr-only", row), title);
        layer.appendChild(el("div", "skyline-meta-line"));
        const settings = this.spoilers();
        if (card.overview && !hidesCardOverview(card, settings)) layer.appendChild(el("p", "skyline-synopsis", card.overview));
        // Aired date and cast, and saved-file chips, come from Home's detail reads; the line keeps its space until then.
        const detailLine = el("div", "skyline-detail-line");
        detailLine.appendChild(el("span", "skyline-detail-text"));
        layer.append(detailLine, el("div", "skyline-badges"));
        this.fillDetails(layer, card, continuing);
        // `.transaction { $0.animation = nil }`: the new text replaces the old in the same frame.
        for (const old of Array.from(this.marquee.querySelectorAll(".skyline-marquee-layer"))) old.remove();
        this.marquee.appendChild(layer);
        // A two-line title costs the synopsis a line (Apple synopsisLineLimit).
        layer.classList.toggle("skyline-title-wrapped", title.offsetHeight > parseFloat(getComputedStyle(title).fontSize) * 1.4);
        this.refreshTranslation(layer);
        // The text title shows first; the logo replaces it only once decoded and only while title art is on.
        const logo = this.titleArt() ? artworkUrl(card.logoUrl, this.baseUrl) : undefined;
        if (logo !== undefined) {
            const image = el("img", "skyline-logo");
            image.alt = title.textContent ?? "";
            image.referrerPolicy = "no-referrer";
            image.addEventListener("load", () => {
                if (!this.titleArt() || !layer.isConnected) return;
                title.textContent = "";
                title.classList.add("skyline-title-logo");
                title.appendChild(image);
                layer.classList.add("skyline-title-wrapped");
            });
            image.src = logo;
        }
    }

    /**
     * TVMainTabView.anchoredPanel (silo-apple 7e478b2 `tvOS/Navigation/TVMainTabView.swift:622-633`): a closing panel
     * fades and shrinks to 0.96 toward its anchor over easeOut(0.12); the sign-out confirmation fades over easeOut(0.2)
     * (`Components/AccountRemovalConfirmation.swift:31,34`). Reduce Motion snaps it away.
     */
    private leave(): void {
        if (!this.visible || this.selector.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const panel = this.selector.getBoundingClientRect();
        // The live order, scrim first: copies share z-index 6, so their order is their stacking.
        const live = [this.scrim, this.selector, this.flyout].filter(node => !node.hidden);
        const ghosts = live.map(node => {
            const ghost = node.cloneNode(true) as HTMLElement;
            // The copy keeps its look but answers to none of the live panel's names, ids or focus keys.
            for (const part of [ghost, ...Array.from(ghost.querySelectorAll<HTMLElement>("*"))]) {
                part.removeAttribute("id");
                part.removeAttribute("data-focus");
            }
            ghost.classList.replace("skyline-selector", "skyline-selector-leaving");
            ghost.classList.replace("skyline-flyout", "skyline-flyout-leaving");
            ghost.classList.replace("skyline-dropdown-scrim", "skyline-dropdown-scrim-leaving");
            ghost.classList.add("skyline-panel-leaving");
            if (node === this.flyout) {
                // One scale for the whole cascade: the flyout shrinks toward the same anchor point as level 1.
                const flyout = node.getBoundingClientRect();
                ghost.style.transformOrigin = `${panel.left + this.panelOrigin - flyout.left}px ${panel.top - flyout.top}px`;
            }
            return ghost;
        });
        this.leaving.append(...ghosts);
        // cloneNode drops scroll state: a scrolled library list fades from the rows on screen.
        ghosts.forEach((ghost, index) => { ghost.scrollTop = live[index]?.scrollTop ?? 0; });
        const timer = window.setTimeout(() => { for (const ghost of ghosts) ghost.remove(); }, PANEL_LEAVE_MILLISECONDS);
        this.clearLeaving = () => {
            window.clearTimeout(timer);
            this.leaving.replaceChildren();
        };
    }

    /** `panelTransitionAnchorX` (TVMainTabView.swift:683-694): the panel grows from under its anchor's centre, at its top edge. */
    private anchorOrigin(anchor: HTMLElement): void {
        const rect = anchor.getBoundingClientRect();
        // offsetLeft is the untransformed position, so the 0.96 start frame does not skew it.
        this.panelOrigin = Math.min(Math.max(rect.left + rect.width / 2 - this.selector.offsetLeft, 0), this.selector.offsetWidth);
        this.selector.style.transformOrigin = `${this.panelOrigin}px 0px`;
    }

    private close(fade = true): void {
        if (fade) this.leave();
        this.cancelDwell();
        this.cancelFlyout();
        this.flyout.hidden = true;
        this.panelTab = undefined;
        this.panelLibrary = undefined;
        this.panelAnchor = undefined;
        this.confirmation = false;
        this.selector.removeAttribute("data-confirmation");
        this.scrim.removeAttribute("data-confirmation");
        this.selector.removeAttribute("aria-modal");
        this.selector.removeAttribute("aria-label");
        this.selector.removeAttribute("data-menu-kind");
        this.selector.setAttribute("role", "menu");
        this.selector.style.top = "";
        this.selector.style.transformOrigin = "";
        this.profileOpen = false;
        this.selector.hidden = true;
        this.scrim.hidden = true;
        this.panel = [];
        this.updateChrome();
        this.update(this.libraries);
    }

    private back(): boolean {
        if (!this.selector.hidden) {
            const type = this.panelAnchor;
            this.close();
            this.dismissedAnchor = type;
            this.refresh({ zone: "nav", key: type ?? this.selected });
        } else if (!this.nav.contains(document.activeElement)) {
            this.items.find((item) => item.key === this.selected)?.element.focus({ preventScroll: true });
        } else if (this.selected !== "home") this.commit("home");
        // handleExitPress (TVTopMenuBar.swift:643-656): on Home, Back from any other bar element returns to the Home tab first.
        else if (document.activeElement !== this.items.find(item => item.key === "home")?.element) this.items.find(item => item.key === "home")?.element.focus({ preventScroll: true });
        else return false;
        return true;
    }

    private updateChrome(): void {
        const open = !this.selector.hidden;
        this.nav.classList.toggle("skyline-muted", !open && !this.nav.contains(document.activeElement));
        const anchor = this.panelAnchor;
        for (const item of this.items) {
            if (item.element.hasAttribute("aria-haspopup")) item.element.setAttribute("aria-expanded", String(open && item.key === anchor));
        }
    }

    private readonly onFocus = (event: FocusEvent): void => {
        if (!this.visible) return;
        this.updateChrome();
        const row = this.panel.find((candidate) => candidate.element === event.target);
        if (row !== undefined) {
            if (this.profileOpen || !row.key.startsWith("library:")) return;
            this.libraryRow = row;
            this.cancelFlyout();
            this.cancelFlyout = this.clock.schedule(() => this.showFlyout(row), 150);
            return;
        }
        const item = this.items.find((candidate) => candidate.element === event.target);
        if (item === undefined) {
            this.cancelDwell();
            this.dismissedAnchor = undefined;
            // enterContentFromBar (TVMainTabView.swift:955-958): focus leaving the bar for the page closes a passive panel
            // (`!panelHasFocus`), so a dwell that opened just before a late load cannot stay over the content. A panel the
            // viewer entered, or one rebuilding its rows, never loses focus from the bar, so it stays.
            const from = event.relatedTarget instanceof Node ? event.relatedTarget : null;
            if (!this.selector.hidden && !this.confirmation && this.nav.contains(from)) {
                this.close();
                // FocusHost keeps the focused card; this only drops the closed panel's zones, outside the render that moved focus.
                queueMicrotask(() => { if (this.visible && this.selector.hidden) this.refresh(); });
            }
            return;
        }
        for (const tab of this.items) tab.element.removeAttribute("data-selection-motion");
        const dismissed = !this.selector.hidden;
        this.close();
        if (dismissed) {
            this.refresh({ zone: "nav", key: item.key });
            if (!item.element.isConnected) return;
        }
        if (this.dismissedAnchor === item.key) return;
        this.dismissedAnchor = undefined;
        if (this.roots.contains(item.element)) {
            const row = this.roots.getBoundingClientRect();
            const rect = item.element.getBoundingClientRect();
            const delta = rect.left < row.left ? rect.left - row.left : rect.right > row.right ? rect.right - row.right : 0;
            if (delta !== 0) this.scroll.move(this.roots, this.roots.scrollLeft + delta, 0);
        }
        if (item.key === "profiles") {
            this.cancelDwell = this.clock.schedule(() => {
                if (document.activeElement === item.element && this.visible) this.openProfile();
            }, 250);
            return;
        }
        if (!item.element.hasAttribute("aria-haspopup")) return;
        this.cancelDwell = this.clock.schedule(() => {
            if (document.activeElement !== item.element || !this.visible) return;
            this.openRootPanel(item);
        }, 250);
    };

    private menuItem(key: string, title: string, action: () => void, icon = key): FocusItem {
        const item = actionButton(key, title, () => { if (this.visible) action(); });
        item.element.classList.add("skyline-menu-item");
        item.element.replaceChildren(menuIcon(icon), el("span", "skyline-menu-label", title));
        item.element.setAttribute("role", "menuitem");
        return item;
    }

    private renderPanel(): void {
        const header = el("div", "skyline-menu-header", this.panelTitle);
        // The For You header is hidden from VoiceOver; the panel is spoken as "For You menu" (TVTopMenuBar.swift:1045, :1050).
        if (this.panelAnchor === "for_you") header.setAttribute("aria-hidden", "true");
        replaceNodes(this.selector, [header, ...this.panel.map(item => item.element)]);
    }

    private openRootPanel(item: FocusItem): void {
        this.close();
        this.panelAnchor = item.key;
        this.selector.setAttribute("data-menu-kind", item.key === "for_you" ? "for_you" : "library");
        if (item.key === "for_you") {
            this.panelTitle = "FOR YOU";
            const personal = this.profiles.personal;
            this.panel = personal === undefined ? [] : (["watchlist", "favorites"] as const).map(source => this.menuItem(source, PERSONAL_TITLES[source], () => { this.close(); personal(source, "for_you"); }));
            this.panel.push(this.menuItem("recommendations", "Recommendations", () => this.commit("for_you"), "Recommended"));
            // bookmark.fill, heart.fill and sparkles are solid glyphs (TVTopMenuBar.swift:1034-1037).
            for (const row of this.panel) row.element.querySelector("svg")?.setAttribute("fill", "currentColor");
        } else {
            const shortcut = this.libraries.find(library => item.key === `library:${library.id}`);
            const type = item.key === "music" ? "music" : item.key === "audiobooks" || shortcut?.type === "audiobooks" ? "audiobooks" : item.key === "series" || shortcut?.type === "series" ? "series" : "movies";
            this.panelTab = type;
            this.panelLibrary = shortcut;
            const libraries = this.forType(type);
            const single = shortcut ?? (libraries.length === 1 ? libraries[0] : undefined);
            this.panelTitle = single === undefined ? type === "movies" ? "MOVIE LIBRARIES" : type === "audiobooks" ? "AUDIOBOOK LIBRARIES" : "SERIES LIBRARIES" : single.name.toUpperCase();
            this.panel = single === undefined ? libraries.map(library => {
                const row = this.menuItem(`library:${library.id}`, library.name, () => this.commit({ ...library, type }), type);
                row.element.setAttribute("role", "menuitemradio");
                row.element.setAttribute("aria-checked", String(library.id === this.scope(type)?.id));
                return row;
            }) : this.modeItems(single, type);
        }
        this.renderPanel();
        this.selector.hidden = false;
        this.selector.setAttribute("aria-label", item.key === "for_you" ? "For You menu" : `${this.panelTitle} menu`);
        const anchor = item.element.getBoundingClientRect();
        this.selector.style.left = `${Math.max(88, Math.min(1372, anchor.left + anchor.width / 2 - 230))}px`;
        this.selector.style.right = "auto";
        this.anchorOrigin(item.element);
        this.updateChrome();
        this.refresh();
    }

    private readonly onKey = (event: KeyboardEvent): void => {
        if (!this.visible) return;
        const key = remoteKey(event);
        const anchor = this.items.find(item => item.element === document.activeElement);
        if (key === "down" && anchor?.element.hasAttribute("aria-haspopup")) {
            // Down enters the avatar menu unless Back has closed it. A press before the
            // dwell finishes still opens the menu. After Back, the page's first card is
            // the candidate, so that Down is left for the content focus host.
            if (anchor.key === "profiles" && !this.profileOpen && this.dismissedAnchor === "profiles") return;
            event.preventDefault();
            this.cancelDwell();
            // enterOpenPanel (TVMainTabView.swift:845-853): a panel the dwell already opened is entered, not reopened.
            if (this.selector.hidden || this.panelAnchor !== anchor.key) {
                if (anchor.key === "profiles") this.openProfile();
                else this.openRootPanel(anchor);
            }
            const current = this.panelTab === undefined ? undefined : this.scope(this.panelTab);
            (this.panel.find(item => item.key === `library:${current?.id}`) ?? this.panel[0])?.element.focus({ preventScroll: true });
            return;
        }
        if (this.confirmation && (key === "up" || key === "down")) { event.preventDefault(); return; }
        if (this.flyout.contains(document.activeElement) && key === "left") {
            event.preventDefault();
            this.libraryRow?.element.focus({ preventScroll: true });
            return;
        }
        if (this.flyout.contains(document.activeElement) && key === "right") {
            event.preventDefault();
            return;
        }
        const index = this.panel.findIndex((row) => row.element === document.activeElement);
        if (index === 0 && key === "up" && !this.confirmation) {
            event.preventDefault();
            this.back();
            return;
        }
        if (index === this.panel.length - 1 && index >= 0 && key === "down" && this.panelAnchor === "for_you") {
            event.preventDefault();
            this.close();
            this.refresh();
            return;
        }
        if (index >= 0 && (key === "down" || key === "up")) {
            event.preventDefault();
            const row = this.panel[Math.max(0, Math.min(this.panel.length - 1, index + (key === "down" ? 1 : -1)))];
            row?.element.focus({ preventScroll: true });
            if (row !== undefined) {
                const rect = row.element.getBoundingClientRect();
                const bounds = this.selector.getBoundingClientRect();
                const delta = rect.top < bounds.top + 14 ? rect.top - bounds.top - 14 : rect.bottom > bounds.bottom - 14 ? rect.bottom - bounds.bottom + 14 : 0;
                this.scroll.move(this.selector, 0, Math.max(0, this.selector.scrollTop + delta));
            }
            return;
        }
        if (index >= 0 && key === "right" && !this.confirmation) {
            event.preventDefault();
            const row = this.panel[index];
            if (this.profileOpen || !row?.key.startsWith("library:")) return;
            if (row !== undefined) this.showFlyout(row);
            this.flyoutItem?.element.focus({ preventScroll: true });
            return;
        }
        const back = key === "back";
        if (back && this.selector.hidden && this.routeBack !== undefined) {
            event.preventDefault();
            this.routeBack();
        } else if (back && (!this.selector.hidden || (this.selected !== "search" && !(this.selected === "home" && anchor?.key === "home")))) {
            event.preventDefault();
            this.back();
        } else if (key === "down" && !this.selector.hidden && this.nav.contains(document.activeElement)) {
            event.preventDefault();
            const current = this.panelTab === undefined ? undefined : this.scope(this.panelTab);
            (this.panel.find((item) => item.key === `library:${current?.id}`) ?? this.panel[0])?.element.focus({ preventScroll: true });
        }
    };

    destroy(): void {
        this.hide();
        this.cancelTranslation();
        this.cancelFade();
        this.scroll.stop();
        this.container.removeEventListener("focusin", this.onFocus);
        this.container.removeEventListener("keydown", this.onKey, true);
        this.scopes.clear();
    }
    private cancelFade = (): void => undefined;

    /** The marquee the dwell was armed for is still the one on screen. */
    private marqueeOnScreen(): boolean {
        return this.visible && this.marqueeShown && this.marquee.isConnected;
    }

    /** A row appearing or going while the menu is open replaces every row, so focus returns to the row it was on. */
    private rebuildProfile(): void {
        const focusedKey = this.panel.find(item => item.element === document.activeElement)?.key;
        this.openProfile(false, false);
        if (focusedKey !== undefined) this.panel.find(item => item.key === focusedKey)?.element.focus({ preventScroll: true });
    }

    private openProfile(enter = false, fade = true): void {
        if (!this.visible) return;
        // openProfilePanelImmediately (TVMainTabView.swift:835-841): pressing the avatar enters a menu the dwell opened.
        if (fade && this.profileOpen && !this.selector.hidden) {
            if (enter) this.panel[0]?.element.focus({ preventScroll: true });
            return;
        }
        this.close(fade);
        this.profileOpen = true;
        this.panelAnchor = "profiles";
        this.selector.setAttribute("data-menu-kind", "profile");
        this.selector.setAttribute("aria-label", "Profile menu");
        this.panel = [this.menuItem("switch-profile", "Switch Profile", this.profiles.switchProfile)];
        const personal = this.profiles.personal;
        if (personal !== undefined) for (const source of ["history"] as const) {
            this.panel.push(this.menuItem(source, PERSONAL_TITLES[source], () => { this.close(); personal(source); }));
        }
        const requests = this.profiles.requests;
        if (this.requestsEnabled && requests !== undefined) this.panel.push(this.menuItem("requests", "Requests", () => { this.close(); requests(); }));
        const watchParty = this.profiles.watchParty;
        if (this.watchPartyEnabled && watchParty !== undefined) this.panel.push(this.menuItem("watch-party", "Watch Party", () => { this.close(); watchParty(); }));
        const settings = this.profiles.settings;
        if (settings !== undefined) this.panel.push(this.menuItem("settings", "Settings", () => { this.close(); settings(); }));
        const switchServer = this.profiles.switchServer;
        if (switchServer !== undefined) this.panel.push(this.menuItem("switch-server", "Change Account", switchServer));
        if (this.profiles.signOut !== undefined) {
            const item = this.menuItem("signout", "Sign Out", () => this.confirmSignOut());
            item.element.classList.add("skyline-destructive");
            this.panel.push(item);
        }
        for (const item of this.panel) item.element.setAttribute("role", "menuitem");
        const header = el("div", "skyline-profile-header");
        const labels = el("div", "skyline-profile-labels");
        labels.append(el("div", "skyline-profile-title", this.profiles.name), el("div", "skyline-profile-server", (this.profiles.serverName?.() ?? new URL(this.baseUrl).host).toUpperCase()));
        header.append(profileMenuAvatar(this.profiles.name, this.avatarReference, this.avatarText, this.baseUrl, 44), labels);
        const divider = el("div", "skyline-menu-divider");
        const rows: HTMLElement[] = [];
        for (const item of this.panel) { if (item.key === "settings") rows.push(divider); rows.push(item.element); }
        replaceNodes(this.selector, [header, ...rows]);
        this.selector.style.left = "auto";
        this.selector.style.right = "88px";
        this.selector.hidden = false;
        this.anchorOrigin(this.items.find(item => item.key === "profiles")?.element ?? this.selector);
        this.scrim.hidden = true;
        this.updateChrome();
        this.refresh();
        if (enter) this.panel[0]?.element.focus({ preventScroll: true });
    }

    private confirmSignOut(): void {
        const signOut = this.profiles.signOut;
        if (signOut === undefined) return;
        this.close();
        this.confirmation = true;
        this.panelAnchor = "profiles";
        this.selector.setAttribute("role", "alertdialog");
        this.selector.setAttribute("aria-modal", "true");
        this.selector.setAttribute("aria-label", "Sign Out");
        this.selector.setAttribute("data-confirmation", "true");
        this.scrim.setAttribute("data-confirmation", "true");
        this.scrim.hidden = false;
        this.panel = [actionButton("cancel-signout", "Cancel", () => this.back()), actionButton("confirm-signout", "Sign Out", () => { if (!this.visible || !this.confirmation) return; this.close(); signOut(); })];
        this.panel[1]?.element.classList.add("skyline-destructive");
        const header = el("div", "skyline-confirm-header");
        const copy = signOutConfirmationCopy(this.profiles.accountName, this.profiles.serverName?.(), this.profiles.lastAccount === true);
        header.append(el("h2", "skyline-confirm-title", copy.title), el("p", "skyline-confirm-message", copy.message));
        const actions = el("div", "skyline-confirm-actions");
        actions.append(...this.panel.map(item => item.element));
        replaceNodes(this.selector, [header, actions]);
        this.selector.style.left = "50%";
        this.selector.style.right = "auto";
        this.selector.style.top = "50%";
        this.selector.hidden = false;
        this.updateChrome();
        this.refresh();
        this.panel[0]?.element.focus({ preventScroll: true });
    }

    private modeItems(library: UserLibrary, type: VideoTab): FocusItem[] {
        // tvOS's cascade offers three destinations; legacy filters stay within Browse.
        return (["Recommended", "Collections", "Browse"] as const).map(mode => {
            const item = this.menuItem(`section:${mode === "Browse" ? "browse" : mode}`, mode, () => this.commit(this.panelAnchor === `library:${library.id}` ? library : { ...library, type }, mode), mode);
            item.element.setAttribute("role", "menuitem");
            return item;
        });
    }

    private showFlyout(row: FocusItem): void {
        this.cancelFlyout();
        if (this.selector.hidden || this.panelTab === undefined) return;
        const library = this.libraries.find((candidate) => `library:${candidate.id}` === row.key);
        if (library === undefined) return;
        this.flyoutItems = this.modeItems(library, this.panelTab);
        this.flyoutItem = this.flyoutItems[0];
        replaceNodes(this.flyout, this.flyoutItems.map(item => item.element));
        this.flyout.style.left = `${Math.min(1532, this.selector.getBoundingClientRect().right + 18)}px`;
        this.flyout.style.top = `${Math.min(900, row.element.getBoundingClientRect().top)}px`;
        this.flyout.hidden = false;
        this.refresh();
    }
}
