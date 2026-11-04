import type { RequestSpec } from "../api/http.ts";
import { audiobookOperations, type AudioGroup } from "../api/audiobookOperations.ts";
import { audiobookResume, bookPosition, type Audiobook, type AudioPage } from "../contracts/v2/audiobooks.ts";
import type { UserLibrary } from "../contracts/v2/catalog.ts";
import type { View } from "./browseFocus.ts";
import type { PlayRequest } from "./browseModel.ts";
import { artworkUrl, clockTime } from "./browseModel.ts";
import { actionButton, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";

type Page = { library: UserLibrary; group?: AudioGroup; name?: string; detail?: string; chapters?: boolean; cursor?: string | undefined; data?: AudioPage; book?: Audiobook };
export class Audiobooks {
    private stack: Page[] = [];
    private abort: AbortController | undefined;
    private busy = false;
    private failure = false;
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
    private open(page: Page): void { this.stack.push(page); void this.load(); }
    private back = (): void => {
        this.abort?.abort(); this.busy = false; this.failure = false;
        if (this.stack.length === 0) { this.exit(); return; }
        this.stack.pop(); this.changed();
    };
    private async load(): Promise<void> {
        this.abort?.abort();
        const abort = new AbortController(); this.abort = abort;
        const page = this.stack.at(-1);
        if (page === undefined) return;
        this.busy = true; this.failure = false; this.changed();
        try {
            if (page.detail !== undefined) {
                const book = await this.read(audiobookOperations.detail(page.detail), abort.signal);
                if (!abort.signal.aborted) for (const entry of this.stack) if (entry.detail === page.detail) entry.book = book;
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
    view(): View {
        const page = this.stack.at(-1);
        const book = page?.book;
        const controls = [actionButton("back", "Back", this.back)];
        const content: HTMLElement[] = [el("h1", "browse-title", book?.title ?? "Audiobooks (Beta)")];
        if (this.busy) content.push(el("p", "browse-text", "Loading"));
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
            } else if (book.parts.length) {
                const resume = audiobookResume(book.position, book.duration);
                controls.push(actionButton("play", resume === undefined ? "Play" : "Resume", () => this.start(book, resume ?? 0)));
                if (book.chapters.length || book.parts.length > 1) controls.push(actionButton("chapters", "Chapters", () => { this.stack.push({ ...page, chapters: true }); this.changed(); }));
                controls.push(actionButton("start-over", "Start Over", () => this.start(book, 0)));
            } else content.push(el("p", "browse-text", "No playable versions available."));
        } else {
            if (page.name === undefined) for (const group of ["author", "narrator", "series"] as const) controls.push(actionButton(group, `By ${group}`, () => this.open({ library: page.library, group })));
            for (const item of page.data?.items ?? []) controls.push(actionButton(item.id, item.title, () => this.open(page.group !== undefined && page.name === undefined ? { library: page.library, group: page.group, name: item.id } : { library: page.library, detail: item.id })));
            if (!this.busy && !this.failure && page.data?.items.length === 0) content.push(el("p", "browse-text", "No audiobooks available."));
            if (page.data?.cursor !== undefined) controls.push(actionButton("next", "Next page", () => this.open({ library: page.library, ...(page.group === undefined ? {} : { group: page.group }), ...(page.name === undefined ? {} : { name: page.name }), cursor: page.data?.cursor })));
        }
        content.push(zoneNode("browse-actions", controls));
        return { name: `audiobooks:${this.stack.length}:${page?.detail ?? page?.group ?? "libraries"}`, content, zones: [{ id: "audio", layout: "column", items: controls }], focus: { zone: "audio", key: controls[1]?.key ?? "back" }, back: this.back };
    }
}
