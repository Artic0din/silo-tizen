import type { RequestSpec } from "../api/http.ts";
import { audiobookOperations, type AudioGroup } from "../api/audiobookOperations.ts";
import { audiobookResume, audiobookPrimaryLabel, bookPosition, type Audiobook, type AudioPage } from "../contracts/v2/audiobooks.ts";
import type { UserLibrary, HomeSection, Card } from "../contracts/v2/catalog.ts";
import { operations } from "../api/operations.ts";
import type { LibraryMode } from "./libraryDiscovery.ts";
import type { LibraryCollections, CatalogLetters } from "../contracts/v2/discovery.ts";
import type { View } from "./browseFocus.ts";
import type { PlayRequest } from "./browseModel.ts";
import { artworkUrl, clockTime } from "./browseModel.ts";
import { actionButton, cardItem, zoneNode, type ViewContext } from "./browseViews.ts";
import { el } from "./screen.ts";
import { detailOperations } from "../api/detailOperations.ts";
import { detailAction } from "./detailsActions.ts";
import { audiobookDetail } from "./audiobookDetail.ts";
import { feedGrid, stopFeed } from "./catalogFeed.ts";

type Page = { library: UserLibrary; mode?: LibraryMode; collection?: string; collectionSource?: "library_collection" | "user_collection"; prefix?: string; letters?: CatalogLetters; sections?: readonly HomeSection[]; collections?: LibraryCollections; group?: AudioGroup; name?: string; detail?: string; chapters?: boolean; cursor?: string | undefined; data?: AudioPage; book?: Audiobook; favorite?: boolean | undefined };
export class Audiobooks {
    private stack: Page[] = [];
    private abort: AbortController | undefined;
    private busy = false;
    private failure = false;
    private saving = false;
    private writeError = false;
    private readonly cards = new WeakMap<AudioPage["items"][number], Card>();
    private readonly libraries: readonly UserLibrary[];
    private readonly read: <T>(spec: RequestSpec<T>, signal: AbortSignal) => Promise<T>;
    private readonly changed: () => void;
    private readonly play: (request: PlayRequest) => void;
    private readonly exit: () => void;
    private readonly baseUrl: string;
    private readonly context: Partial<ViewContext>;
    constructor(libraries: readonly UserLibrary[], read: Audiobooks["read"], changed: () => void, play: Audiobooks["play"], exit: () => void, baseUrl: string, library?: UserLibrary, context: Partial<ViewContext> = {}) {
        this.context = context;
        this.libraries = libraries; this.read = read; this.changed = changed; this.play = play; this.exit = exit; this.baseUrl = baseUrl;
        if (library !== undefined) this.stack.push({ library, mode: "Recommended" });
    }
    enter(): void { const page = this.stack[0]; if (page === undefined) return; this.stack = [page]; if (page.data === undefined && page.sections === undefined && page.collections === undefined) void this.load(); }
    selectMode(mode: LibraryMode): void {
        const library = this.stack[0]?.library;
        if (library === undefined) return;
        this.stack = [{ library, mode }]; void this.load();
    }
    stop(): void { this.abort?.abort(); for (const page of this.stack) stopFeed(page); }
    get isLibrary(): boolean { return this.stack.length === 1 && this.stack[0]?.detail === undefined; }
    get recommends(): boolean { return this.isLibrary && this.stack[0]?.mode === "Recommended"; }
    refresh(): void { if (this.stack.at(-1)?.detail !== undefined) void this.load(); }
    private open(page: Page): void { const current = this.stack.at(-1); if (current !== undefined) stopFeed(current); this.writeError = false; this.stack.push(page); void this.load(); }
    private back = (): void => {
        const current = this.stack.at(-1); if (current !== undefined) stopFeed(current);
        this.abort?.abort(); this.busy = false; this.failure = false; this.writeError = false;
        if (this.stack.length <= 1) { this.exit(); return; }
        this.stack.pop();
        const page = this.stack.at(-1);
        if (page !== undefined && page.data === undefined && page.book === undefined) void this.load();
        else { this.abort = new AbortController(); this.changed(); }
    };
    private async load(): Promise<void> {
        this.abort?.abort();
        const abort = new AbortController(); this.abort = abort;
        const page = this.stack.at(-1);
        if (page === undefined) return;
        this.busy = true; this.failure = false; this.changed();
        try {
            if (page.detail !== undefined) {
                const favoriteRead = this.read(detailOperations.membership("favorites", page.detail), abort.signal).then(value => {
                    if (value.id !== page.detail) throw new Error("Membership item mismatch");
                    return value.member;
                }).catch(() => undefined);
                const [book, favorite] = await Promise.all([this.read(audiobookOperations.detail(page.detail), abort.signal), favoriteRead]);
                if (!abort.signal.aborted) for (const entry of this.stack) if (entry.detail === page.detail) { entry.book = book; entry.favorite = favorite; }
            }
            else if (page.mode === "Recommended") page.sections = await this.read(operations.listLibrarySections(page.library.id), abort.signal);
            else if (page.mode === "Collections") page.collections = await this.read(operations.getLibraryCollections(page.library.id), abort.signal);
            else {
                const previous = page.cursor === undefined ? [] : page.data?.items ?? [];
                const letters = page.mode === "Browse" && page.letters === undefined ? this.readLetters(page, abort.signal) : Promise.resolve(page.letters);
                const [data, alphabet] = await Promise.all([this.read(page.group !== undefined && page.name === undefined
                ? audiobookOperations.groups(page.library.id, page.group, page.cursor)
                : audiobookOperations.books(page.library.id, page.group, page.name, page.cursor, { collection: page.collection, prefix: page.prefix, source: page.collectionSource }), abort.signal), letters]);
                if (abort.signal.aborted) return;
                page.data = data;
                if (alphabet !== undefined) page.letters = alphabet;
                if (previous.length > 0) page.data = { ...page.data, items: [...previous, ...page.data.items.filter(item => !previous.some(old => old.id === item.id))] };
            }
        } catch { if (!abort.signal.aborted) this.failure = true; }
        if (abort.signal.aborted) return;
        this.busy = false; this.changed();
    }
    private async readLetters(page: Page, signal: AbortSignal): Promise<CatalogLetters | undefined> {
        try {
            const capabilities = await this.read(operations.getCatalogSearchCapabilities(), signal);
            if (!capabilities.allowed || capabilities.state !== "available" || !capabilities.letterIndex) return undefined;
            return await this.read(audiobookOperations.letters(page.library.id), signal);
        } catch {
            // The optional index must never discard a successful book query.
            return undefined;
        }
    }
    private start(book: Audiobook, position: number): void {
        const target = bookPosition(book, position);
        this.play({ contentId: book.id, title: book.title, fileId: target.fileId, startSeconds: target.startSeconds, allowAlternateVersions: false, audiobook: book });
    }
    private async toggle(page: Page, kind: "favorites" | "watched"): Promise<void> {
        const book = page.book;
        if (book === undefined || this.saving || this.busy || kind === "favorites" && page.favorite === undefined) return;
        const abort = this.abort;
        if (abort === undefined || abort.signal.aborted) return;
        const enabled = !(kind === "favorites" ? page.favorite : book.finished);
        this.saving = true; this.writeError = false; this.changed();
        try {
            await this.read(detailOperations.setPersonal(kind, book.id, enabled), abort.signal);
            if (!abort.signal.aborted) for (const entry of this.stack) if (entry.detail === book.id) {
                if (kind === "favorites") entry.favorite = enabled;
                else if (entry.book !== undefined) entry.book = { ...entry.book, finished: enabled };
            }
        } catch { if (!abort.signal.aborted) this.writeError = true; }
        finally { this.saving = false; if (!abort.signal.aborted) this.changed(); }
    }
    view(): View {
        const page = this.stack.at(-1);
        const book = page?.book;
        const controls = [actionButton("back", "Back", this.back)];
        const content: HTMLElement[] = this.isLibrary ? [] : [el("h1", "browse-title", book?.title ?? "Audiobooks")];
        if (this.busy) content.push(el("p", "browse-text", "Loading"));
        if (this.saving) content.push(el("p", "browse-text", "Saving…"));
        if (this.writeError) { const error = el("p", "browse-error", "Could not save the change. Try again."); error.setAttribute("role", "alert"); content.push(error); }
        if (book !== undefined && page?.favorite === undefined && !this.busy) {
            const error = el("p", "browse-error", "Could not load Favorites."); error.setAttribute("role", "alert"); content.push(error);
            controls.push(actionButton("retry", "Retry", () => { void this.load(); }));
        }
        if (this.failure) {
            content.push(el("p", "browse-error", "Could not load audiobooks."));
            controls.push(actionButton("retry", "Retry", () => { void this.load(); }));
        }
        if (page === undefined) {
            for (const library of this.libraries.filter(library => library.type === "audiobooks")) controls.push(actionButton(library.id, library.name, () => this.open({ library })));
        } else if (book !== undefined) {
            const poster = artworkUrl(book.poster, this.baseUrl);
            if (poster !== undefined) { const image = el("img", "browse-poster"); image.src = poster; image.alt = ""; content.push(image); }
            content.push(el("p", "browse-text", book.overview), el("p", "browse-text", clockTime(book.duration)));
            if (page.chapters) {
                const chapters = book.chapters.length ? book.chapters : book.parts.map((part, index) => ({ title: `Part ${index + 1}`, start: part.offset }));
                for (const [index, chapter] of chapters.entries()) controls.push(actionButton(`chapter:${index}`, `${chapter.title} · ${clockTime(chapter.start)}`, () => this.start(book, chapter.start)));
                if (!chapters.length) content.push(el("p", "browse-text", "No chapters available."));
            } else {
                if (book.parts.length) {
                    const resume = audiobookResume(book.position, book.duration);
                    controls.push(actionButton("play", audiobookPrimaryLabel(book), () => this.start(book, resume ?? 0)));
                    if (book.chapters.length || book.parts.length > 1) controls.push(actionButton("chapters", "Chapters", () => { this.stack.push({ ...page, chapters: true }); this.changed(); }));
                    controls.push(actionButton("start-over", "Start Over", () => this.start(book, 0)));
                } else content.push(el("p", "browse-text", "No playable versions available."));
                for (const [key, title, kind, active, label] of [
                    ["favorite", "Favorite", "favorites", page.favorite === true, page.favorite ? "Remove from Favorites" : "Add to Favorites"],
                    ["finished", "Finished", "watched", book.finished === true, book.finished ? "Mark as Not Finished" : "Mark as Finished"],
                ] as const) {
                    const item = actionButton(key, title, () => { void this.toggle(page, kind); });
                    item.element.setAttribute("aria-pressed", String(active));
                    if (this.saving || this.busy || kind === "favorites" && page.favorite === undefined) item.element.setAttribute("aria-disabled", "true");
                    detailAction(item).element.setAttribute("aria-label", label);
                    controls.push(item);
                }
            }
        } else {
            if (page.mode === "Recommended" || page.mode === "Collections") {
                const zones: import("./browseFocus.ts").Zone[] = [{ id: "audio", layout: "column", items: controls }];
                const grouped = new Set(page.collections?.groups.filter(group => group.kind === "admin").flatMap(group => group.collections.map(collection => collection.id)) ?? []);
                const ungrouped = page.collections?.ungrouped?.collections ?? page.collections?.collections.filter(collection => !grouped.has(collection.id)) ?? [];
                const collectionGroups = [...(page.collections?.groups ?? []), { id: "ungrouped", name: "", sortOrder: page.collections?.ungrouped?.sortOrder ?? 9999, collections: ungrouped }].sort((a, b) => a.sortOrder - b.sortOrder);
                const rows = (page.sections?.map(section => ({ id: section.id, title: section.title, items: section.items.map(card => ({ id: card.id, title: card.title, poster: card.posterUrl, card })) })) ?? collectionGroups.map(group => ({ id: group.id, title: group.name, items: group.collections.map(collection => ({ id: collection.id, title: collection.title, poster: collection.posterUrl })) }))).filter(row => row.items.length > 0);
                for (const row of rows) {
                    const cards = row.items.flatMap(item => {
                        const source = "card" in item ? item.card : { id: item.id, title: item.title, type: "unknown" as const, posterUrl: item.poster, year: undefined, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined };
                        const card = cardItem(source, { ...this.context, baseUrl: this.baseUrl, cardDestination: card => ({ kind: "item", id: card.id, title: card.title }), open: destination => { if (destination.kind === "item") this.open(page.mode === "Collections" ? { library: page.library, collection: destination.id, collectionSource: page.collections?.groups.find(group => group.collections.some(collection => collection.id === destination.id))?.kind === "user_collections" ? "user_collection" : "library_collection" } : { library: page.library, detail: destination.id }); } });
                        if (card === undefined) return [];
                        card.element.classList.add(page.mode === "Collections" ? "collection-poster" : "audiobook-card"); card.element.setAttribute("aria-label", item.title); return [card];
                    });
                    const section = el("section", "home-section"); section.dataset.section = row.id;
                    if (row.title) section.append(el("h2", "browse-section-title", row.title));
                    section.append(zoneNode(page.mode === "Collections" ? "browse-grid catalog-grid discovery-collection-grid" : "browse-row audiobook-rail", cards));
                    content.push(section);
                    zones.push({ id: `section:${row.id}`, layout: page.mode === "Collections" ? "grid" : "row", columns: 6, items: cards });
                }
                if (!this.busy && !this.failure && rows.length === 0) content.push(el("p", "browse-text", page.mode === "Collections" ? "No collections yet" : "No titles"));
                content.push(zoneNode("browse-actions", controls));
                const first = zones.find(zone => zone.id !== "audio" && zone.items.length > 0);
                return { name: `audiobooks:library:${page.library.id}:${page.mode}`, content, zones, focus: first === undefined ? { zone: "audio", key: "back" } : { zone: first.id, key: first.items[0]!.key }, back: this.back };
            }
            if (!this.busy && !this.failure && page.data?.items.length === 0) content.push(el("p", "browse-text", "No audiobooks available."));
            const items = (page.data?.items ?? []).map(item => {
                let card = this.cards.get(item);
                if (card === undefined) { card = { id: item.id, title: item.title, type: "unknown", posterUrl: item.poster, year: undefined, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined }; this.cards.set(item, card); }
                return card;
            });
            const grid = feedGrid(page, { items, nextCursor: page.data?.cursor, total: undefined, totalExact: false }, { ...this.context, baseUrl: this.baseUrl, cardDestination: card => ({ kind: "item", id: card.id, title: card.title }), open: destination => { if (destination.kind === "item") this.open({ library: page.library, detail: destination.id }); } }, 6 * 8, this.busy || this.failure, () => {
                if (this.busy || this.failure || this.stack.at(-1) !== page || page.data?.cursor === undefined) return;
                page.cursor = page.data.cursor; void this.load();
            });
            grid.content[0]?.classList.add("audiobook-grid");
            const cards = grid.zones[0]?.items ?? [];
            for (const card of cards) { card.element.classList.add("audiobook-card"); card.element.setAttribute("aria-label", items.find(item => item.id === card.key)?.title ?? ""); }
            const letters = (page.letters?.letters ?? []).map(letter => actionButton(`letter:${letter.letter}`, letter.letter, () => { page.prefix = letter.letter; page.cursor = undefined; delete page.data; void this.load(); }));
            return { name: `audiobooks:grid:${page.library.id}:${page.collection ?? "browse"}`, content: [...content, ...grid.content, zoneNode("discovery-letters", letters), zoneNode("browse-actions", controls)], zones: [...grid.zones.map(zone => ({ ...zone, right: "letters" })), { id: "letters", layout: "column", left: "grid", items: letters }, { id: "audio", layout: "column", items: controls }], focus: cards[0] === undefined ? { zone: "audio", key: "back" } : { zone: "grid", key: cards[0].key }, back: this.back };
        }
        const detail = book !== undefined && !page?.chapters;
        const actions = detail ? controls.filter(item => item.key !== "back" && item.key !== "retry") : [];
        const list = controls.filter(item => !actions.includes(item));
        if (detail && book !== undefined && page !== undefined) {
            const notices = content.filter(node => node.classList.contains("browse-error") || node.textContent === "Saving…" || node.textContent === "No playable versions available.");
            const presentation = audiobookDetail(book, actions, this.baseUrl, id => this.open({ library: page.library, detail: id }), notices);
            return { name: `audiobooks:detail:${book.id}`, content: [...presentation.content, zoneNode("audiobook-back", list)], zones: [...presentation.zones, { id: "audio", layout: "column", items: list }], focus: { zone: "audio-actions", key: actions[0]?.key ?? "back" }, back: this.back };
        }
        content.push(zoneNode("browse-actions browse-panel-list audiobook-list", list));
        if (detail) content.push(zoneNode("browse-actions audiobook-detail-actions", actions));
        return { name: `audiobooks:${this.stack.length}:${page?.library.id ?? ""}:${page?.detail ?? page?.group ?? "libraries"}:${page?.name ?? ""}:${page?.cursor ?? ""}`, content,
            zones: [{ id: "audio", layout: "column", items: list }, ...(detail ? [{ id: "audio-actions", layout: "row" as const, items: actions }] : [])],
            focus: { zone: detail ? "audio-actions" : "audio", key: detail ? actions[0]?.key ?? "back" : controls[1]?.key ?? "back" }, back: this.back };
    }
}
