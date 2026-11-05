import type { RequestSpec } from "../api/http.ts";
import { audiobookOperations, type AudioGroup } from "../api/audiobookOperations.ts";
import { audiobookResume, bookPosition, type Audiobook, type AudioPage } from "../contracts/v2/audiobooks.ts";
import type { UserLibrary } from "../contracts/v2/catalog.ts";
import type { View } from "./browseFocus.ts";
import type { PlayRequest } from "./browseModel.ts";
import { artworkUrl, clockTime } from "./browseModel.ts";
import { actionButton, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";
import { detailOperations } from "../api/detailOperations.ts";
import { detailAction } from "./detailsActions.ts";

type Page = { library: UserLibrary; group?: AudioGroup; name?: string; detail?: string; chapters?: boolean; cursor?: string | undefined; data?: AudioPage; book?: Audiobook; favorite?: boolean | undefined };
export class Audiobooks {
    private stack: Page[] = [];
    private abort: AbortController | undefined;
    private busy = false;
    private failure = false;
    private saving = false;
    private writeError = false;
    private readonly libraries: readonly UserLibrary[];
    private readonly read: <T>(spec: RequestSpec<T>, signal: AbortSignal) => Promise<T>;
    private readonly changed: () => void;
    private readonly play: (request: PlayRequest) => void;
    private readonly exit: () => void;
    private readonly baseUrl: string;
    constructor(libraries: readonly UserLibrary[], read: Audiobooks["read"], changed: () => void, play: Audiobooks["play"], exit: () => void, baseUrl: string) {
        this.libraries = libraries; this.read = read; this.changed = changed; this.play = play; this.exit = exit; this.baseUrl = baseUrl;
    }
    stop(): void { this.abort?.abort(); }
    refresh(): void { if (this.stack.at(-1)?.detail !== undefined) void this.load(); }
    private open(page: Page): void { this.writeError = false; this.stack.push(page); void this.load(); }
    private back = (): void => {
        this.abort?.abort(); this.busy = false; this.failure = false; this.writeError = false;
        if (this.stack.length === 0) { this.exit(); return; }
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
            else page.data = await this.read(page.group !== undefined && page.name === undefined
                ? audiobookOperations.groups(page.library.id, page.group, page.cursor)
                : audiobookOperations.books(page.library.id, page.group, page.name, page.cursor), abort.signal);
        } catch { if (!abort.signal.aborted) this.failure = true; }
        if (abort.signal.aborted) return;
        this.busy = false; this.changed();
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
        const content: HTMLElement[] = [el("h1", "browse-title", book?.title ?? "Audiobooks")];
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
                    controls.push(actionButton("play", resume === undefined ? "Play" : "Resume", () => this.start(book, resume ?? 0)));
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
            if (page.name === undefined) for (const group of ["author", "narrator", "series"] as const) controls.push(actionButton(group, `By ${group}`, () => this.open({ library: page.library, group })));
            for (const item of page.data?.items ?? []) controls.push(actionButton(item.id, item.title, () => this.open(page.group !== undefined && page.name === undefined ? { library: page.library, group: page.group, name: item.id } : { library: page.library, detail: item.id })));
            if (!this.busy && !this.failure && page.data?.items.length === 0) content.push(el("p", "browse-text", "No audiobooks available."));
            if (page.data?.cursor !== undefined) controls.push(actionButton("next", "Next page", () => this.open({ library: page.library, ...(page.group === undefined ? {} : { group: page.group }), ...(page.name === undefined ? {} : { name: page.name }), cursor: page.data?.cursor })));
        }
        const detail = book !== undefined && !page?.chapters;
        const actions = detail ? controls.filter(item => item.key !== "back" && item.key !== "retry") : [];
        const list = controls.filter(item => !actions.includes(item));
        content.push(zoneNode("browse-actions browse-panel-list audiobook-list", list));
        if (detail) content.push(zoneNode("browse-actions audiobook-detail-actions", actions));
        return { name: `audiobooks:${this.stack.length}:${page?.library.id ?? ""}:${page?.detail ?? page?.group ?? "libraries"}:${page?.name ?? ""}:${page?.cursor ?? ""}`, content,
            zones: [{ id: "audio", layout: "column", items: list }, ...(detail ? [{ id: "audio-actions", layout: "row" as const, items: actions }] : [])],
            focus: { zone: detail ? "audio-actions" : "audio", key: detail ? actions[0]?.key ?? "back" : controls[1]?.key ?? "back" }, back: this.back };
    }
}
