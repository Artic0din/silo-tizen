import type { Clock } from "../api/clock.ts";
import type { Card, UserLibrary } from "../contracts/v2/catalog.ts";
import type { PublicStorage } from "../session/deviceIdentity.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { artworkUrl } from "./browseModel.ts";
import { marqueeBadges, marqueeMeta, marqueeRating, marqueeTitle } from "./cardPresentation.ts";
import { actionButton, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";
import { TMDB_LOGO_PATH } from "./acknowledgements.ts";
import { SkylineScroll } from "./skylineScroll.ts";
import { remoteKey } from "./keys.ts";
import { heroBackdrop, type Tints } from "./heroBackdrop.ts";
import type { LibraryMode } from "./libraryDiscovery.ts";
import { PERSONAL_TITLES, type PersonalSource } from "./personalLists.ts";

type VideoTab = "movies" | "series";

interface ProfileMenu {
    readonly settings?: () => void;
    readonly personal?: (source: PersonalSource) => void;
    readonly name: string;
    readonly switchProfile: () => void;
    readonly signOut?: () => void;
}

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
    setRequestsEnabled(enabled: boolean): void {
        this.requestsEnabled = enabled;
        this.update(this.libraries);
    }

    private routeBack: (() => void) | undefined;
    private readonly nav = el("nav", "browse-nav");
    private readonly tabs = el("div", "skyline-tabs");
    private readonly tools = el("div", "skyline-tools");
    private readonly selector = el("div", "skyline-selector");
    private readonly marquee = el("div", "skyline-marquee");
    private readonly body = el("div", "skyline-content");
    private readonly scrim = el("div", "skyline-dropdown-scrim");
    private readonly flyout = el("div", "skyline-selector skyline-flyout");
    private flyoutItem: FocusItem | undefined;
    private flyoutItems: FocusItem[] = [];
    private libraryModes: readonly LibraryMode[] = ["Recommended", "Collections", "Browse"];
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
    private cancelPreview = (): void => undefined;
    private previewId: string | undefined;
    private readonly tints = new Map<string, Tints>();
    private selected = "home";
    private scopes = new Map<VideoTab, string>();
    private visible = false;
    private immediatePreview = true;
    private readonly container: HTMLElement;
    private readonly clock: Clock;
    private readonly activate: (target: "home" | "search" | "calendar" | "requests" | UserLibrary, mode?: LibraryMode) => void;
    private readonly profiles: ProfileMenu;
    private readonly refresh: () => void;
    private readonly storage: PublicStorage | undefined;
    private readonly storageKey: string;
    private readonly baseUrl: string;
    /** Whether the profile's title-art setting lets a logo replace the marquee title. */
    titleArt: () => boolean = () => false;
    filled: (card: Card) => Card = card => card;
    /** What Home's detail reads added for a title: the aired and cast line, and Continue Watching's saved-file chips. */
    details: (card: Card, continuing: boolean) => { readonly line: string | undefined; readonly badges: readonly string[] | undefined } = () => ({ line: undefined, badges: undefined });
    private shown: { card: Card; row: string; continuing: boolean } | undefined;

    constructor(
        container: HTMLElement,
        clock: Clock,
        activate: (target: "home" | "search" | "calendar" | "requests" | UserLibrary, mode?: LibraryMode) => void,
        profiles: ProfileMenu,
        refresh: () => void,
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
        this.flyout.hidden = true;
        this.flyout.setAttribute("role", "menu");
        this.marquee.setAttribute("aria-live", "polite");
        this.marquee.setAttribute("aria-atomic", "true");
        container.addEventListener("focusin", this.onFocus);
        container.addEventListener("keydown", this.onKey, true);
    }

    update(libraries: readonly UserLibrary[]): void {
        this.libraries = libraries;
        const keys = ["home", ...(["movies", "series"] as const).filter((type) => this.forType(type).length > 0), ...(this.requestsEnabled ? ["requests"] : []), "search", "profiles", "calendar"];
        if (this.items.map((item) => item.key).join(":") === keys.join(":")) return;
        this.items = [actionButton("home", "Home", () => this.commit("home"))];
        for (const type of ["movies", "series"] as const) {
            if (this.forType(type).length === 0) continue;
            const item = actionButton(type, type === "movies" ? "Movies" : "Series", () => {
                const library = this.scope(type);
                if (library !== undefined) this.commit({ ...library, type });
            });
            item.element.setAttribute("aria-haspopup", "menu");
            this.items.push(item);
        }
        if (this.requestsEnabled) this.items.push(actionButton("requests", "Requests", () => this.commit("requests")));
        this.items.push(actionButton("search", "", () => this.commit("search")), actionButton("profiles", this.profiles.name.slice(0, 1).toUpperCase(), () => this.openProfile()), actionButton("calendar", "Calendar", () => this.commit("calendar")));
        const search = this.items.find((item) => item.key === "search");
        search?.element.setAttribute("aria-label", "Search");
        search?.element.classList.add("skyline-search");
        const profiles = this.items.find((item) => item.key === "profiles");
        profiles?.element.setAttribute("aria-label", "Profiles");
        profiles?.element.classList.add("skyline-profile");
        profiles?.element.setAttribute("aria-haspopup", "menu");
        for (const item of this.items.slice(0, -3)) item.element.setAttribute("role", "tab");
        replaceNodes(this.tabs, this.items.slice(0, -3).map((item) => item.element));
        replaceNodes(this.tools, this.items.slice(-3).map((item) => item.element));
    }

    private forType(type: VideoTab): readonly UserLibrary[] {
        return this.libraries.filter((library) => library.type === type || library.type === "mixed");
    }

    private scope(type: VideoTab): UserLibrary | undefined {
        let id = this.scopes.get(type);
        if (id === undefined) {
            try { id = this.storage?.getItem(`${this.storageKey}:${type}`) ?? undefined; } catch { /* Session scope remains available when storage is blocked. */ }
        }
        return this.forType(type).find((library) => library.id === id) ?? this.forType(type)[0];
    }

    setLibraryModes(modes: readonly LibraryMode[]): void {
        if (this.libraryModes.length === modes.length && this.libraryModes.every((mode, index) => mode === modes[index])) return;
        this.libraryModes = modes;
        const type = this.panelTab;
        if (type === undefined || this.selector.hidden || this.profileOpen) return;
        const libraries = this.forType(type);
        const library = libraries.length === 1 ? libraries[0] : undefined;
        if (library === undefined) return;
        const previous = this.panel;
        const focused = previous.find(item => item.element === document.activeElement);
        this.panel = this.modeItems(library, type).map(item => previous.find(candidate => candidate.key === item.key) ?? item);
        replaceNodes(this.selector, this.panel.map(item => item.element));
        if (focused !== undefined) (this.panel.find(item => item.key === focused.key) ?? this.panel[0])?.element.focus({ preventScroll: true });
    }

    private commit(target: "home" | "search" | "calendar" | "requests" | UserLibrary, mode?: LibraryMode): void {
        if (typeof target !== "string") {
            const type = this.panelTab ?? (target.type === "series" ? "series" : "movies");
            this.scopes.set(type, target.id);
            try { this.storage?.setItem(`${this.storageKey}:${type}`, target.id); } catch { /* Keep the selection for this session. */ }
        }
        this.close();
        this.activate(target, mode);
    }

    decorate(view: View, selected: string, preview: boolean, routeBack?: () => void, libraryKey?: string): View {
        this.routeBack = routeBack;
        this.visible = true;
        if (this.selected !== selected) this.immediatePreview = true;
        this.selected = selected;
        for (const item of this.items) {
            item.element.setAttribute("aria-current", item.key === selected ? "page" : "false");
            if (item.element.getAttribute("role") === "tab") item.element.setAttribute("aria-selected", String(item.key === selected));
        }
        const zones: Zone[] = [{ id: "nav", layout: "row", items: this.items }];
        if (!this.selector.hidden) zones.push({ id: "selector", layout: "column", items: this.panel });
        if (!this.flyout.hidden) zones.push({ id: "flyout", layout: "column", items: this.flyoutItems });
        const prepare = (): void => {
            this.container.classList.add("skyline-root");
            this.container.classList.toggle("skyline-preview", preview);
            this.container.classList.toggle("skyline-home", preview && selected === "home");
            this.container.classList.toggle("skyline-library", preview && (selected === "movies" || selected === "series"));
            this.container.classList.toggle("skyline-grid", !preview && (selected === "movies" || selected === "series" || selected === "profiles"));
            view.content.forEach((node, index) => {
                const existing = this.body.children[index];
                if (existing !== node) this.body.insertBefore(node, existing ?? null);
            });
            while (this.body.children.length > view.content.length) this.body.lastElementChild?.remove();
        };
        return { ...view, prepare, transition: { key: libraryKey ?? selected, group: selected }, content: [this.scrim, this.nav, this.selector, this.flyout, ...(preview ? [this.marquee] : []), this.body], zones: [...zones, ...view.zones], back: selected === "search" ? view.back : () => this.back() };
    }

    hide(): void {
        this.routeBack = undefined;
        this.visible = false;
        this.close();
        this.cancelPreview();
        this.container.classList.remove("skyline-root", "skyline-preview", "skyline-library", "skyline-home");
    }

    /** Redraws the shown preview, as when the title-art answer lands. */
    repaint(): void {
        const shown = this.shown;
        if (shown !== undefined && this.previewId === `${shown.row}:${shown.card.id}`) this.draw(shown.card, shown.row, shown.continuing);
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
        if (line !== null) line.textContent = details.line ?? "";
        const badges = layer.querySelector(".skyline-badges");
        if (badges !== null) replaceNodes(badges as HTMLElement, (details.badges ?? marqueeBadges(card.overlay)).map(badge => el("span", "skyline-chip", badge)));
    }

    preview(card: Card, row: string, continuing = false): void {
        this.cancelPreview();
        const apply = (): void => {
            const identity = `${row}:${card.id}`;
            if (this.previewId === identity && this.shown?.card === card && this.shown.continuing === continuing) return;
            this.previewId = identity;
            this.immediatePreview = false;
            this.draw(card, row, continuing);
        };
        if (this.previewId === undefined || this.immediatePreview) apply();
        else this.cancelPreview = this.clock.schedule(apply, 150);
    }

    private draw(card: Card, row: string, continuing: boolean): void {
        this.shown = { card, row, continuing };
        // Apple's marquee (TVMarqueeBlock): the row name is spoken, never drawn.
        const layer = el("div", "skyline-marquee-layer");
        const title = el("h1", "skyline-title", marqueeTitle(card));
        layer.append(el("span", "skyline-row-name silo-sr-only", row), title);
        layer.appendChild(el("div", "skyline-meta-line"));
        if (card.overview) layer.appendChild(el("p", "skyline-synopsis", card.overview));
        // Aired date and cast, and saved-file chips, come from Home's detail reads; the line keeps its space until then.
        layer.append(el("div", "skyline-detail-line"), el("div", "skyline-badges"));
        this.fillDetails(layer, card, continuing);
        const seriesArt = card.type === "episode" && card.seriesBackdropUrl !== undefined;
        const background = artworkUrl(seriesArt ? card.seriesBackdropUrl : card.backdropUrl, this.baseUrl);
        if (background !== undefined && this.selected === "home") {
            layer.prepend(heroBackdrop(background, seriesArt ? undefined : card.backdropThumbhash, this.tints));
        } else if (background !== undefined) {
            const image = el("img", "skyline-backdrop");
            image.alt = "";
            image.referrerPolicy = "no-referrer";
            image.src = background;
            image.addEventListener("error", () => image.remove());
            layer.prepend(image, el("div", "skyline-scrim"));
        }
        const outgoing = this.marquee.lastElementChild;
        this.marquee.appendChild(layer);
        // A two-line title costs the synopsis a line (Apple synopsisLineLimit).
        layer.classList.toggle("skyline-title-wrapped", title.offsetHeight > parseFloat(getComputedStyle(title).fontSize) * 1.4);
        // The text title shows first; the logo replaces it only once decoded and only while title art is on.
        const logo = this.titleArt() ? artworkUrl(card.logoUrl, this.baseUrl) : undefined;
        if (logo !== undefined) {
            const image = el("img", "skyline-logo");
            image.alt = title.textContent ?? "";
            image.referrerPolicy = "no-referrer";
            image.addEventListener("load", () => {
                if (!this.titleArt() || !layer.isConnected || layer.classList.contains("skyline-outgoing")) return;
                title.textContent = "";
                title.classList.add("skyline-title-logo");
                title.appendChild(image);
                layer.classList.add("skyline-title-wrapped");
            });
            image.src = logo;
        }
        if (outgoing !== null) {
            outgoing.setAttribute("aria-hidden", "true");
            outgoing.classList.add("skyline-outgoing");
            this.cancelFade();
            this.cancelFade = this.clock.schedule(() => {
                for (const old of Array.from(this.marquee.children)) if (old !== layer) old.remove();
            }, 240);
        }
    }

    private close(): void {
        this.cancelDwell();
        this.cancelFlyout();
        this.flyout.hidden = true;
        this.panelTab = undefined;
        this.profileOpen = false;
        this.selector.hidden = true;
        this.scrim.hidden = true;
        this.panel = [];
    }

    private back(): boolean {
        if (!this.selector.hidden) {
            const type = this.profileOpen ? "profiles" : this.panelTab;
            this.close();
            this.dismissedAnchor = type;
            this.items.find((item) => item.key === type)?.element.focus({ preventScroll: true });
            this.refresh();
        } else if (!this.nav.contains(document.activeElement)) {
            this.items.find((item) => item.key === this.selected)?.element.focus({ preventScroll: true });
        } else if (this.selected !== "home") this.commit("home");
        else return false;
        return true;
    }

    private readonly onFocus = (event: FocusEvent): void => {
        if (!this.visible) return;
        this.nav.classList.toggle("skyline-muted", !(event.target instanceof Node && this.nav.contains(event.target)));
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
            return;
        }
        const dismissed = !this.selector.hidden;
        this.close();
        if (dismissed) this.refresh();
        if (this.dismissedAnchor === item.key) return;
        this.dismissedAnchor = undefined;
        if (item.key === "profiles") {
            this.cancelDwell = this.clock.schedule(() => {
                if (document.activeElement === item.element && this.visible) this.openProfile();
            }, 250);
            return;
        }
        if (item.key !== "movies" && item.key !== "series") return;
        const type = item.key;
        this.cancelDwell = this.clock.schedule(() => {
            if (document.activeElement !== item.element || !this.visible) return;
            this.panelTab = type;
            const libraries = this.forType(type);
            const single = libraries.length === 1 ? libraries[0] : undefined;
            this.panel = single === undefined
                ? libraries.map((library) => actionButton(`library:${library.id}`, library.name, () => this.commit({ ...library, type })))
                : this.modeItems(single, type);
            if (single === undefined) for (const row of this.panel) {
                row.element.setAttribute("role", "menuitemradio");
                row.element.setAttribute("aria-checked", String(row.key === `library:${this.scope(type)?.id}`));
            }
            replaceNodes(this.selector, this.panel.map((row) => row.element));
            this.selector.hidden = false;
            this.scrim.hidden = false;
            this.selector.style.left = `${Math.max(88, Math.min(1372, item.element.getBoundingClientRect().left - 100))}px`;
            this.selector.style.right = "auto";
            this.refresh();
        }, 250);
    };

    private readonly onKey = (event: KeyboardEvent): void => {
        if (!this.visible) return;
        const key = remoteKey(event);
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
        if (index >= 0 && key === "right") {
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
        } else if (back && (!this.selector.hidden || (this.selected !== "search" && (!this.nav.contains(document.activeElement) || this.selected !== "home")))) {
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
        this.cancelFade();
        this.scroll.stop();
        this.container.removeEventListener("focusin", this.onFocus);
        this.container.removeEventListener("keydown", this.onKey, true);
        this.scopes.clear();
    }
    private cancelFade = (): void => undefined;

    private openProfile(): void {
        this.close();
        this.profileOpen = true;
        this.panel = [actionButton("switch-profile", "Switch profile", this.profiles.switchProfile)];
        const personal = this.profiles.personal;
        if (personal !== undefined) for (const source of ["watchlist", "favorites", "history"] as const) {
            this.panel.push(actionButton(source, PERSONAL_TITLES[source], () => { this.close(); personal(source); }));
        }
        const settings = this.profiles.settings;
        if (settings !== undefined) this.panel.push(actionButton("settings", "Settings", () => { this.close(); settings(); }));
        if (this.profiles.signOut !== undefined) this.panel.push(actionButton("signout", "Sign out", this.profiles.signOut));
        for (const item of this.panel) item.element.setAttribute("role", "menuitem");
        replaceNodes(this.selector, [el("h2", "skyline-profile-name", this.profiles.name), ...this.panel.map((item) => item.element)]);
        this.selector.style.left = "auto";
        this.selector.style.right = "88px";
        this.selector.hidden = false;
        this.scrim.hidden = false;
        this.refresh();
    }

    private modeItems(library: UserLibrary, type: VideoTab): FocusItem[] {
        return this.libraryModes.map(mode => {
            const item = actionButton(`section:${mode === "Browse" ? "browse" : mode}`, mode, () => this.commit({ ...library, type }, mode));
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
