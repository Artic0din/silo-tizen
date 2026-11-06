import type { Clock } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { subtitleSearchOperations as operations } from "../api/subtitleSearchOperations.ts";
import type { SearchResult } from "../contracts/v2/subtitleSearch.ts";
import type { NativeSession } from "../session/session.ts";
import { languageChoices, languageLabel, type LanguageChoice } from "./subtitleAppearance.ts";

export type SearchPhase = "closed" | "languages" | "searching" | "results" | "failed";

export interface SubtitleSearchView {
    readonly offered: boolean;
    readonly unavailableReason: string;
    readonly phase: SearchPhase;
    readonly suggested: readonly LanguageChoice[];
    readonly other: readonly LanguageChoice[];
    readonly language: string | undefined;
    readonly status: string;
    readonly message: string;
    readonly warnings: readonly string[];
    readonly canRetry: boolean;
    readonly results: readonly SearchResult[];
    readonly downloadingKey: string | undefined;
}

const SEARCHING = "Searching providers… This can take up to half a minute.";
const STORED = "The subtitle was saved but couldn't be turned on now. It will be available the next time you play this video.";
const UNCONFIRMED = "Silo couldn't confirm the download. If it was saved, it will be available the next time you play this video.";
const UNAVAILABLE = "Not set up on this server";

export class SubtitleSearch {
    private readonly session: NativeSession;
    readonly fileId: string;
    private readonly onAdded: (id: string) => boolean;
    private readonly changed: () => void;
    private readonly abort = new AbortController();
    private searchAbort = new AbortController();
    private probe = 0;
    private searchGeneration = 0;
    private catalogGeneration = 0;
    private offered = true;
    private unavailableReason = "";
    private phase: SearchPhase = "closed";
    private suggested: readonly LanguageChoice[] = [];
    private other: readonly LanguageChoice[] = [];
    private language: string | undefined;
    private status = "";
    private message = "";
    private warnings: readonly string[] = [];
    private canRetry = false;
    private results: readonly SearchResult[] = [];
    private downloadingKey: string | undefined;
    private readonly settled = new Map<string, string>();

    constructor(session: NativeSession, clock: Clock, fileId: string, onAdded: (id: string) => boolean, changed: () => void) {
        void clock;
        this.session = session;
        this.fileId = fileId;
        this.onAdded = onAdded;
        this.changed = changed;
    }

    get view(): SubtitleSearchView {
        return {
            offered: this.offered, unavailableReason: this.unavailableReason, phase: this.phase,
            suggested: this.suggested, other: this.other, language: this.language, status: this.status,
            message: this.message, warnings: this.warnings, canRetry: this.canRetry, results: this.results,
            downloadingKey: this.downloadingKey,
        };
    }

    destroy(): void {
        this.abort.abort();
        this.searchAbort.abort();
    }

    async refresh(): Promise<void> {
        const probe = ++this.probe;
        try {
            const status = await this.call(operations.providerStatus());
            if (this.abort.signal.aborted || probe !== this.probe) return;
            this.offered = status.available;
            this.unavailableReason = status.available ? "" : UNAVAILABLE;
            if (!status.available && this.phase === "languages") {
                this.phase = "failed";
                this.message = UNAVAILABLE;
                this.canRetry = false;
            }
            this.changed();
        } catch { /* A failed probe is not an answer, so the last offered state stays. */ }
    }

    open(): void {
        if (this.abort.signal.aborted || this.downloadingKey !== undefined) return;
        this.phase = this.offered ? "languages" : "failed";
        this.status = "";
        this.message = this.offered ? "" : this.unavailableReason || UNAVAILABLE;
        this.canRetry = false;
        this.changed();
        void this.loadLanguages();
    }

    back(): void {
        if (this.abort.signal.aborted || this.downloadingKey !== undefined || this.phase === "closed") return;
        this.cancelSearch();
        this.phase = this.phase === "languages" ? "closed" : "languages";
        this.status = "";
        this.message = "";
        this.canRetry = false;
        this.changed();
    }

    async retry(): Promise<void> {
        if (this.abort.signal.aborted || this.downloadingKey !== undefined) return;
        if (this.language !== undefined) {
            await this.pick(this.language);
            return;
        }
        this.phase = "languages";
        this.message = "";
        this.canRetry = false;
        this.changed();
        await this.loadLanguages();
    }

    close(): void {
        if (this.abort.signal.aborted || this.phase === "closed" || this.downloadingKey !== undefined) return;
        this.cancelSearch();
        this.phase = "closed";
        this.status = "";
        this.message = "";
        this.canRetry = false;
        this.changed();
    }

    async pick(language: string): Promise<void> {
        if (this.abort.signal.aborted || this.downloadingKey !== undefined) return;
        if (!this.offered) {
            this.phase = "failed";
            this.status = "";
            this.message = this.unavailableReason || UNAVAILABLE;
            this.canRetry = false;
            this.changed();
            return;
        }
        const generation = ++this.searchGeneration;
        this.searchAbort.abort();
        this.searchAbort = new AbortController();
        this.language = language;
        this.phase = "searching";
        this.status = SEARCHING;
        this.message = "";
        this.warnings = [];
        this.canRetry = false;
        this.results = [];
        this.changed();
        try {
            const response = await this.call(operations.search(this.fileId, language), this.searchAbort.signal);
            if (this.abort.signal.aborted || generation !== this.searchGeneration) return;
            this.results = response.results;
            this.warnings = response.warnings;
            this.phase = "results";
            this.status = "";
            this.message = response.results.length === 0 ? `No subtitles found for ${this.languageName(language)}.` : "";
        } catch (error) {
            if (this.abort.signal.aborted || generation !== this.searchGeneration || (error instanceof ApiError && error.aborted)) return;
            this.phase = "failed";
            this.status = "";
            this.message = detail(error) ?? "Couldn't search for subtitles. Try again.";
            this.canRetry = true;
        }
        this.changed();
    }

    async download(key: string): Promise<void> {
        if (this.abort.signal.aborted || this.downloadingKey !== undefined || this.phase === "closed") return;
        const prior = this.settled.get(key);
        if (prior !== undefined) {
            this.message = prior;
            this.canRetry = false;
            this.changed();
            return;
        }
        const result = this.results.find(item => item.key === key);
        if (result === undefined) return;
        this.downloadingKey = key;
        this.status = "Adding subtitle…";
        this.message = "";
        this.canRetry = false;
        this.changed();
        try {
            const stored = await this.call(operations.download(this.fileId, result));
            if (this.abort.signal.aborted) return;
            if (stored.fileId !== this.fileId || !this.onAdded(stored.id)) {
                this.settled.set(key, STORED);
                this.message = STORED;
                this.phase = "results";
            } else {
                this.phase = "closed";
                this.status = "";
                this.message = "";
            }
        } catch (error) {
            if (this.abort.signal.aborted || (error instanceof ApiError && error.aborted)) return;
            if (unconfirmed(error)) {
                this.settled.set(key, UNCONFIRMED);
                this.message = UNCONFIRMED;
                this.canRetry = false;
            } else {
                this.message = detail(error) ?? "Couldn't add that subtitle. Try another result.";
                this.canRetry = true;
            }
            this.phase = "failed";
        } finally {
            this.downloadingKey = undefined;
            this.status = "";
            if (!this.abort.signal.aborted) this.changed();
        }
    }

    private cancelSearch(): void {
        this.searchGeneration += 1;
        this.searchAbort.abort();
        this.searchAbort = new AbortController();
    }

    private languageName(code: string): string {
        return [...this.suggested, ...this.other].find(choice => choice.code === code)?.label ?? languageLabel(code);
    }

    reportUnselected(): void {
        if (this.abort.signal.aborted) return;
        this.message = STORED;
        this.changed();
    }

    private async loadLanguages(): Promise<void> {
        const generation = ++this.catalogGeneration;
        let catalog: readonly { readonly code: string; readonly label?: string }[] = [];
        let preferred: string | undefined;
        let catalogFailed = false;
        try { catalog = await this.call(operations.languages()); }
        catch (error) {
            if (this.abort.signal.aborted || (error instanceof ApiError && error.aborted)) return;
            catalogFailed = true;
        }
        if (!catalogFailed) {
            try { preferred = await this.call(operations.preferredLanguage()); } catch { preferred = undefined; }
        }
        if (this.abort.signal.aborted || generation !== this.catalogGeneration || this.phase !== "languages") return;
        if (catalogFailed) {
            this.suggested = [];
            this.other = [];
            this.phase = "failed";
            this.status = "";
            this.message = "Couldn't load subtitle languages. Try again.";
            this.canRetry = true;
            this.changed();
            return;
        }
        const choices = languageChoices(catalog, preferred);
        this.suggested = choices.suggested;
        this.other = choices.other;
        this.changed();
    }

    private call<T>(spec: RequestSpec<T>, signal: AbortSignal = this.abort.signal): Promise<T> {
        return this.session.call({ ...spec, profileScoped: true, replayAfterRefresh: spec.method === "GET", signal });
    }
}

function detail(error: unknown): string | undefined {
    if (!(error instanceof ApiError) || error.failure.kind !== "problem") return undefined;
    const text = error.failure.problem.detail;
    return text !== undefined && text.trim() !== "" ? text : undefined;
}

function unconfirmed(error: unknown): boolean {
    if (!(error instanceof ApiError)) return true;
    const kind = error.failure.kind;
    if (kind === "network" || kind === "timeout" || kind === "invalid_response") return true;
    const status = error.status;
    return status !== undefined && status >= 500;
}
