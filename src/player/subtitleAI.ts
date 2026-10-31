import type { Clock } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { subtitleAIOperations as operations, type SubtitleAIRequest } from "../api/subtitleAIOperations.ts";
import type { SubtitleAIJob, SubtitleAIQuota, SubtitleAIStatus } from "../contracts/v2/subtitleAI.ts";
import type { NativeSession } from "../session/session.ts";

export interface AIResult { readonly id: string; readonly label: string }
export interface SubtitleAIView {
    readonly available: SubtitleAIStatus;
    readonly languages: readonly string[];
    readonly quota: SubtitleAIQuota | undefined;
    readonly busy: boolean;
    readonly message: string;
    readonly results: readonly AIResult[];
}

export class SubtitleAI {
    private readonly session: NativeSession;
    private readonly clock: Clock;
    readonly fileId: string;
    private readonly changed: () => void;
    private readonly abort = new AbortController();
    private readonly stopAuthority: () => void;
    private cancelPoll: (() => void) | undefined;
    private readonly results: AIResult[] = [];
    private busy = false;
    private uncertain = false;
    private message = "";
    private available: SubtitleAIStatus | undefined;
    private languages: readonly string[] = [];
    private quota: SubtitleAIQuota | undefined;

    constructor(session: NativeSession, clock: Clock, fileId: string, changed: () => void) {
        this.session = session;
        this.clock = clock;
        this.fileId = fileId;
        this.changed = changed;
        const signal = session.authoritySignal;
        const cancel = (): void => this.destroy();
        signal.addEventListener("abort", cancel, { once: true });
        this.stopAuthority = () => signal.removeEventListener("abort", cancel);
        if (signal.aborted) this.destroy();
        else void this.discover();
    }

    get view(): SubtitleAIView | undefined {
        return this.available === undefined ? undefined : { available: this.available, languages: this.languages, quota: this.quota, busy: this.busy || this.uncertain, message: this.message, results: this.results };
    }

    destroy(): void {
        this.abort.abort();
        this.cancelPoll?.();
        this.stopAuthority();
    }

    notice(message: string): void {
        if (this.abort.signal.aborted) return;
        this.message = message;
        this.changed();
    }

    private call<T>(spec: RequestSpec<T>): Promise<T> {
        return this.session.call({ ...spec, profileScoped: true, replayAfterRefresh: spec.method === "GET", signal: this.abort.signal });
    }

    private async discover(): Promise<void> {
        try {
            const status = await this.call(operations.subtitleAIStatus());
            if (this.abort.signal.aborted || (!status.translate && !status.transcribe)) return;
            this.available = status;
            this.changed();
            await Promise.all([
                this.call(operations.subtitleAILanguages()).then(languages => { if (!this.abort.signal.aborted) this.languages = languages; }, () => this.notice("Could not load translation languages.")),
                this.refreshQuota(),
            ]);
            if (!this.abort.signal.aborted) this.changed();
        } catch { /* Unsupported AI is omitted; it never gates playback. */ }
    }

    private async refreshQuota(): Promise<void> {
        try {
            const quota = await this.call(operations.subtitleAIQuota());
            if (!this.abort.signal.aborted) { this.quota = quota; this.changed(); }
        } catch { this.notice("Could not read transcription quota. Playback continues."); }
    }

    async start(request: SubtitleAIRequest): Promise<void> {
        if (this.abort.signal.aborted || this.busy || this.uncertain || request.media_file_id !== this.fileId || this.available === undefined) return;
        if (request.kind === "translate" && (!this.available.translate || !this.languages.includes(request.target_language))) return;
        if (request.kind === "transcribe" && (!this.available.transcribe || this.quota === undefined || (this.quota.limited && this.quota.remaining <= 0))) { this.notice("Transcription quota is exhausted or unavailable. Playback continues."); return; }
        this.busy = true;
        this.notice("Starting AI subtitles…");
        try {
            const job = await this.call(operations.createSubtitleAI(request));
            if (this.abort.signal.aborted) return;
            if (job.fileId !== this.fileId || job.kind !== request.kind || job.sourceIndex !== request.source_index || job.id === "" || job.language !== request.target_language) throw new Error("AI job identity mismatch");
            await this.update(job);
        } catch (error) {
            if (this.abort.signal.aborted) return;
            this.busy = false;
            this.uncertain = !(error instanceof ApiError && error.problemId !== undefined && !error.transient);
            this.notice(error instanceof ApiError && error.problemId ? `AI subtitles could not start: ${error.problemId}. Playback continues.` : "Could not confirm the AI request. It may still finish on the server; it was not sent again.");
            void this.refreshQuota();
        }
    }

    private async update(job: SubtitleAIJob): Promise<void> {
        if (this.abort.signal.aborted) return;
        if (job.status === "completed") {
            this.busy = false;
            if (job.resultId !== undefined && !this.results.some(result => result.id === job.resultId)) this.results.push({ id: job.resultId, label: `${job.kind === "translate" ? "AI-translated" : "AI-transcribed"}${job.language ? ` · ${job.language.toUpperCase()}` : ""}` });
            this.notice(job.resultId === undefined ? "AI job completed without a subtitle result." : "AI subtitles are ready to select.");
            void this.refreshQuota();
        } else if (job.status === "failed" || job.status === "cancelled") {
            this.busy = false;
            this.notice(job.error || `AI subtitles ${job.status}. Playback continues.`);
            void this.refreshQuota();
        } else if (job.status === "pending" || job.status === "running") {
            this.notice("Generating AI subtitles…");
            this.cancelPoll = this.clock.schedule(() => {
                void this.call(operations.subtitleAIJob(job.id)).then(next => {
                    if (next.id !== job.id || next.fileId !== this.fileId || next.kind !== job.kind || next.sourceIndex !== job.sourceIndex || next.language !== job.language) throw new Error("AI job identity changed");
                    return this.update(next);
                }).catch(() => { this.busy = false; this.uncertain = true; this.notice("Could not check the AI job. It may still finish on the server; another request is blocked for this playback. Playback continues."); });
            }, 2000);
        } else {
            this.busy = false;
            this.uncertain = true;
            this.notice("The server returned an unknown AI job state. Playback continues.");
        }
    }
}
