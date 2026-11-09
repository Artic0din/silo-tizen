// The profile's stored Resolution cap (`playback.preferred_quality`), which ranks the versions Details
// lists. silo-apple reads it from memory (`PlayerSettings.shared.preferredQuality`), so Details here
// reads it from this cache instead of asking the server on every open. Browse lives for one server and
// profile, so a profile switch starts a fresh cache.
import { operations } from "../api/operations.ts";
import { QUALITY_KEY } from "../contracts/v2/settings.ts";
import type { NativeSession } from "../session/session.ts";

export class ResolutionCap {
    private value: string | undefined;
    private answered = false;
    private controller: AbortController | undefined;
    private readonly session: NativeSession;
    private readonly changed: () => void;

    constructor(session: NativeSession, changed: () => void) {
        this.session = session;
        this.changed = changed;
    }

    /** The stored cap, or undefined while unanswered or when the profile has none. */
    get quality(): string | undefined { return this.value; }

    /** Starts the read unless one is in flight or already answered; a failed read retries on the next call. */
    ensure(): void {
        if (this.controller === undefined && !this.answered) this.load();
    }

    /** Rereads after Settings, keeping the last answer until the new one lands. */
    reload(): void {
        this.load();
    }

    private load(): void {
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        void this.session.call({ ...operations.effectiveSettings([QUALITY_KEY]), profileScoped: true, signal: controller.signal }).then(values => {
            if (this.controller !== controller) return;
            const quality = values.get(QUALITY_KEY)?.value;
            const next = typeof quality === "string" ? quality : undefined;
            this.answered = true;
            const before = this.value;
            this.value = next;
            if (before !== next) this.changed();
        }, () => { /* Without a stored cap versions rank by resolution alone; the next ensure retries. */ }).finally(() => {
            if (this.controller === controller) this.controller = undefined;
        });
    }

    stop(): void {
        this.controller?.abort();
        this.controller = undefined;
    }
}
