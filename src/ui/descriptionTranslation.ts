// On-view description translation for the marquee and Details.
// Apple TV: CardDescriptionTranslation.swift, DescriptionTranslationCoordinator.swift,
// ItemDetailViewModel+DescriptionTranslation.swift, TVSkylineSectionFeed.swift and TVHeroSynopsis.swift.
// Subtitle translation stays in the player. This owner only shares the session and the clock.

import type { Clock } from "../api/clock.ts";
import { descriptionTranslationOperations } from "../api/descriptionTranslationOperations.ts";
import { ApiError } from "../api/errors.ts";
import { operations } from "../api/operations.ts";
import type { Episode, ItemDetail } from "../contracts/v2/catalog.ts";
import type { DescriptionJob } from "../contracts/v2/descriptionTranslation.ts";
import type { OnViewMode } from "../contracts/v2/descriptionTranslation.ts";
import type { NativeSession } from "../session/session.ts";

export type { DescriptionJob, OnViewMode };
export { decodeDescriptionTranslationJob, decodeMetadataAICapability } from "../contracts/v2/descriptionTranslation.ts";

/** Re-read delays. Their sum is the ~45 s cap from DescriptionTranslationCoordinator.defaultSchedule. */
export const DESCRIPTION_TRANSLATION_POLL_MS = [1000, 2000, 2000, 3000, 3000, 4000, 5000, 5000, 5000, 5000, 5000, 5000];
/** How long a featured card must hold the marquee before auto mode starts. TVSkylineMarquee.translationDwell. */
export const MARQUEE_TRANSLATION_DWELL_MS = 1500;
export const TRANSLATING_LABEL = "Translating…";
export const TRANSLATED_BY_AI_LABEL = "Translated by AI";
export const TRANSLATE_DESCRIPTION_LABEL = "Translate Description";

export interface TranslationKey {
    readonly contentId: string;
    readonly targetLanguage: string;
}

export interface DescriptionTranslationStatus {
    readonly kind: "translating" | "machine-translated";
    readonly text: string;
}

/** Translating wins. A tagline-only mark does not label the overview. */
export function descriptionTranslationStatus(translating: boolean, fields: readonly string[] | undefined): DescriptionTranslationStatus | undefined {
    if (translating) return { kind: "translating", text: TRANSLATING_LABEL };
    return fields?.includes("overview") === true ? { kind: "machine-translated", text: TRANSLATED_BY_AI_LABEL } : undefined;
}

/** Featured cards in auto mode only. Button mode leaves the action to Details. */
export function marqueeTranslationRequest(featured: boolean, mode: OnViewMode, contentId: string | undefined, pending: string | undefined): TranslationKey | undefined {
    if (!featured || mode !== "auto" || contentId === undefined || contentId === "" || pending === undefined || pending === "") return undefined;
    return { contentId, targetLanguage: pending };
}

/** The page's own description, and the selected season when one of its episodes is missing a description. */
export function descriptionTargets(detail: ItemDetail, season: { readonly id: string; readonly number: number } | undefined, episodes: readonly Episode[] | undefined): { readonly item?: TranslationKey; readonly season?: TranslationKey } {
    const item = detail.pendingTranslationLanguage === undefined ? undefined : { contentId: detail.id, targetLanguage: detail.pendingTranslationLanguage };
    const pending = detail.type !== "series" || season === undefined ? undefined : episodes?.find((episode) => episode.seasonNumber === season.number && episode.pendingTranslationLanguage !== undefined)?.pendingTranslationLanguage;
    return { ...(item === undefined ? {} : { item }), ...(pending === undefined || season === undefined ? {} : { season: { contentId: season.id, targetLanguage: pending } }) };
}

function isItemDetail(value: ItemDetail | readonly Episode[]): value is ItemDetail {
    return !Array.isArray(value);
}

type Phase = "idle" | "translating" | "failed";

function keyId(key: TranslationKey): string {
    return `${key.contentId}\0${key.targetLanguage}`;
}

/** One POST-then-poll run. Automatic runs start once per item and language until cancel or reset. */
export class DescriptionTranslationCoordinator {
    phase: Phase = "idle";
    key: TranslationKey | undefined;
    private runId = 0;
    private task: Promise<void> | undefined;
    private automatic = new Set<string>();
    private cancelSleep: (() => void) | undefined;
    private readonly clock: Clock;
    private readonly post: (key: TranslationKey) => Promise<DescriptionJob>;
    private readonly onPhase: () => void;

    constructor(clock: Clock, post: (key: TranslationKey) => Promise<DescriptionJob>, onPhase: () => void = () => undefined) {
        this.clock = clock;
        this.post = post;
        this.onPhase = onPhase;
    }

    get isRunning(): boolean { return this.task !== undefined; }

    isTranslating(key: TranslationKey): boolean {
        return this.phase === "translating" && this.key?.contentId === key.contentId && this.key.targetLanguage === key.targetLanguage;
    }

    hasFailed(key: TranslationKey): boolean {
        return this.phase === "failed" && this.key?.contentId === key.contentId && this.key.targetLanguage === key.targetLanguage;
    }

    translateAutomatically(key: TranslationKey, fetch: () => Promise<ItemDetail | readonly Episode[] | undefined>, apply: (value: ItemDetail | readonly Episode[]) => boolean): boolean {
        if (this.automatic.has(keyId(key))) return false;
        if (!this.translate(key, fetch, apply)) return false;
        this.automatic.add(keyId(key));
        return true;
    }

    translate(key: TranslationKey, fetch: () => Promise<ItemDetail | readonly Episode[] | undefined>, apply: (value: ItemDetail | readonly Episode[]) => boolean): boolean {
        if (this.task !== undefined || key.contentId === "" || key.targetLanguage === "") return false;
        this.key = key;
        this.phase = "translating";
        const runId = ++this.runId;
        this.task = this.run(runId, key, fetch, apply);
        this.onPhase();
        return true;
    }

    /** A cancelled automatic run may start again the next time its surface is shown. */
    cancel(): void {
        const running = this.phase === "translating";
        if (running && this.key !== undefined) this.automatic.delete(keyId(this.key));
        this.runId++;
        this.cancelSleep?.();
        this.task = undefined;
        if (running) {
            this.phase = "idle";
            this.onPhase();
        }
    }

    reset(): void {
        this.cancel();
        this.automatic.clear();
        this.key = undefined;
        if (this.phase !== "idle") {
            this.phase = "idle";
            this.onPhase();
        }
    }

    private async run(runId: number, key: TranslationKey, fetch: () => Promise<ItemDetail | readonly Episode[] | undefined>, apply: (value: ItemDetail | readonly Episode[]) => boolean): Promise<void> {
        try {
            try {
                const job = await this.post(key);
                if (!this.current(runId)) return;
                if (job.failed) { this.fail(runId); return; }
            } catch (error) {
                if (!this.current(runId) || (error instanceof ApiError && error.aborted)) return;
                const done = await this.readOnce(runId, fetch, apply);
                if (!this.current(runId) || done === undefined) return;
                if (done) this.finish(runId);
                else this.fail(runId);
                return;
            }
            for (const delay of DESCRIPTION_TRANSLATION_POLL_MS) {
                if (!await this.sleep(delay, runId)) return;
                const done = await this.readOnce(runId, fetch, apply);
                if (!this.current(runId) || done === undefined) return;
                if (done) { this.finish(runId); return; }
            }
            this.fail(runId);
        } finally {
            if (this.runId === runId) this.task = undefined;
        }
    }

    private async readOnce(runId: number, fetch: () => Promise<ItemDetail | readonly Episode[] | undefined>, apply: (value: ItemDetail | readonly Episode[]) => boolean): Promise<boolean | undefined> {
        if (!this.current(runId)) return undefined;
        let value: ItemDetail | readonly Episode[] | undefined;
        try {
            value = await fetch();
        } catch (error) {
            if (!this.current(runId) || (error instanceof ApiError && error.aborted)) return undefined;
            return false;
        }
        if (!this.current(runId)) return undefined;
        if (value === undefined) return false;
        return apply(value);
    }

    private sleep(ms: number, runId: number): Promise<boolean> {
        return new Promise((resolve) => {
            if (!this.current(runId)) { resolve(false); return; }
            const cancel = this.clock.schedule(() => {
                this.cancelSleep = undefined;
                resolve(this.current(runId));
            }, ms);
            this.cancelSleep = () => { cancel(); this.cancelSleep = undefined; resolve(false); };
        });
    }

    private finish(runId: number): void {
        if (!this.current(runId)) return;
        this.phase = "idle";
        this.onPhase();
    }

    private fail(runId: number): void {
        if (!this.current(runId)) return;
        this.phase = "failed";
        this.onPhase();
    }

    private current(runId: number): boolean { return this.runId === runId; }
}

export interface TranslatableText {
    readonly id: string;
    readonly overview?: string | undefined;
    readonly pendingTranslationLanguage?: string | undefined;
    readonly machineTranslatedFields?: readonly string[] | undefined;
}

export interface TranslationPresentation {
    readonly overview: string | undefined;
    readonly status: DescriptionTranslationStatus | undefined;
    readonly pendingLanguage: string | undefined;
}

interface Landed { readonly language: string; readonly overview: string | undefined; readonly machineTranslatedFields: readonly string[] | undefined }

/** Landed marquee text, and the Translate action a card would offer. The marquee itself has no such control. */
export class CardDescriptionTranslation {
    private readonly localized = new Map<string, Landed>();
    private readonly coordinators = new Map<string, DescriptionTranslationCoordinator>();
    private readonly listeners = new Set<() => void>();
    private readonly host: { onView(): OnViewMode };
    private readonly clock: Clock;
    private readonly fetchDetail: (contentId: string) => Promise<ItemDetail | undefined>;
    private readonly post: (contentId: string, language: string) => Promise<DescriptionJob>;

    constructor(host: { onView(): OnViewMode }, clock: Clock, fetchDetail: (contentId: string) => Promise<ItemDetail | undefined>, post: (contentId: string, language: string) => Promise<DescriptionJob>) {
        this.host = host;
        this.clock = clock;
        this.fetchDetail = fetchDetail;
        this.post = post;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    presentation(card: TranslatableText): TranslationPresentation {
        const pending = card.pendingTranslationLanguage || undefined;
        const landed = pending === undefined ? undefined : this.landed(card.id, pending);
        if (landed !== undefined) {
            return { overview: landed.overview ?? card.overview, status: descriptionTranslationStatus(false, landed.machineTranslatedFields), pendingLanguage: undefined };
        }
        const key = pending === undefined ? undefined : { contentId: card.id, targetLanguage: pending };
        const translating = key !== undefined && this.coordinators.get(card.id)?.isTranslating(key) === true;
        return { overview: card.overview, status: descriptionTranslationStatus(translating, card.machineTranslatedFields), pendingLanguage: pending };
    }

    /** Button mode, or either mode after a failed run, while the description is still missing. */
    offers(card: TranslatableText): boolean {
        const mode = this.host.onView();
        const pending = card.pendingTranslationLanguage;
        if (mode === "off" || pending === undefined || pending === "" || this.landed(card.id, pending) !== undefined) return false;
        const key = { contentId: card.id, targetLanguage: pending };
        if (this.coordinators.get(card.id)?.isTranslating(key) === true) return false;
        return mode === "button" || this.coordinators.get(card.id)?.hasFailed(key) === true;
    }

    cardDidAppear(card: TranslatableText): void {
        if (this.host.onView() !== "auto") return;
        this.start(card, true);
    }

    translate(card: TranslatableText): void {
        if (this.host.onView() === "off") return;
        this.start(card, false);
    }

    cancel(contentId: string): void {
        this.coordinators.get(contentId)?.cancel();
        this.bump();
    }

    reset(): void {
        for (const coordinator of this.coordinators.values()) coordinator.reset();
        this.coordinators.clear();
        this.localized.clear();
        this.bump();
    }

    private start(card: TranslatableText, automatic: boolean): void {
        const pending = card.pendingTranslationLanguage;
        if (pending === undefined || pending === "" || this.landed(card.id, pending) !== undefined) return;
        const coordinator = this.coordinator(card.id);
        const key = { contentId: card.id, targetLanguage: pending };
        if (coordinator.isRunning && (coordinator.key?.contentId !== key.contentId || coordinator.key.targetLanguage !== key.targetLanguage)) coordinator.cancel();
        const fetch = async (): Promise<ItemDetail | undefined> => this.fetchDetail(card.id);
        const apply = (value: ItemDetail | readonly Episode[]): boolean => {
            if (!isItemDetail(value)) return false;
            if (value.pendingTranslationLanguage !== undefined) return false;
            this.localized.set(card.id, { language: pending, overview: value.overview, machineTranslatedFields: value.machineTranslatedFields });
            this.bump();
            return true;
        };
        const started = automatic ? coordinator.translateAutomatically(key, fetch, apply) : coordinator.translate(key, fetch, apply);
        if (started) this.bump();
    }

    private coordinator(contentId: string): DescriptionTranslationCoordinator {
        const existing = this.coordinators.get(contentId);
        if (existing !== undefined) return existing;
        const made = new DescriptionTranslationCoordinator(this.clock, (key) => this.post(key.contentId, key.targetLanguage), () => this.bump());
        this.coordinators.set(contentId, made);
        return made;
    }

    private landed(contentId: string, pending: string): Landed | undefined {
        const landed = this.localized.get(contentId);
        return landed?.language === pending ? landed : undefined;
    }

    private bump(): void {
        for (const listener of this.listeners) listener();
    }
}

export interface DetailSurface {
    detail(): ItemDetail;
    season(): { readonly id: string; readonly number: number } | undefined;
    episodes(): readonly Episode[] | undefined;
    seriesId(): string | undefined;
    /** Returns whether the pending language has cleared. True also means the page moved on and the run can stop. */
    replaceDetail(detail: ItemDetail): boolean;
    replaceEpisodes(seasonNumber: number, episodes: readonly Episode[]): boolean;
    changed(): void;
}

/** Details page: the item overview, and a series season's episode overviews. */
export class ItemDescriptionTranslation {
    private readonly item: DescriptionTranslationCoordinator;
    private readonly seasonRun: DescriptionTranslationCoordinator;
    private readonly translations: DescriptionTranslations;
    private readonly session: NativeSession;
    private readonly surface: DetailSurface;
    private closed = true;
    private signal: AbortSignal | undefined;
    private stopMode: (() => void) | undefined;

    constructor(translations: DescriptionTranslations, session: NativeSession, clock: Clock, surface: DetailSurface) {
        this.translations = translations;
        this.session = session;
        this.surface = surface;
        const changed = (): void => { if (!this.closed) this.surface.changed(); };
        this.item = new DescriptionTranslationCoordinator(clock, (key) => this.post(key), changed);
        this.seasonRun = new DescriptionTranslationCoordinator(clock, (key) => this.post(key), changed);
    }

    attach(signal: AbortSignal): void {
        this.signal = signal;
        this.closed = false;
        this.stopMode?.();
        this.stopMode = this.translations.subscribeMode(() => {
            if (this.closed) return;
            this.consider();
            this.surface.changed();
        });
        void this.translations.ensure().then(() => { if (!this.closed && this.signal === signal) this.consider(); });
    }

    stop(): void {
        this.closed = true;
        this.signal = undefined;
        this.stopMode?.();
        this.stopMode = undefined;
        this.item.cancel();
        this.seasonRun.cancel();
    }

    consider(): void {
        if (this.closed || this.translations.onView() !== "auto") return;
        this.begin(true);
    }

    translate(): void {
        if (this.closed || this.translations.onView() === "off") return;
        this.begin(false);
    }

    offers(): boolean {
        const mode = this.translations.onView();
        if (mode === "off" || this.translating()) return false;
        const targets = descriptionTargets(this.surface.detail(), this.surface.season(), this.surface.episodes());
        if (targets.item === undefined && targets.season === undefined) return false;
        if (mode === "button") return true;
        return (targets.item !== undefined && this.item.hasFailed(targets.item)) || (targets.season !== undefined && this.seasonRun.hasFailed(targets.season));
    }

    status(episode: Episode | undefined, playback: ItemDetail | undefined): DescriptionTranslationStatus | undefined {
        if (episode === undefined) return descriptionTranslationStatus(this.itemTranslating(), this.surface.detail().machineTranslatedFields);
        const fields = episode.overview !== undefined && episode.overview !== "" ? episode.machineTranslatedFields : playback?.machineTranslatedFields;
        const season = descriptionTargets(this.surface.detail(), this.surface.season(), this.surface.episodes()).season;
        const translating = season !== undefined && this.seasonRun.isTranslating(season) && episode.pendingTranslationLanguage !== undefined;
        return descriptionTranslationStatus(translating, fields);
    }

    private translating(): boolean { return this.itemTranslating() || this.seasonTranslating(); }

    private itemTranslating(): boolean {
        const key = descriptionTargets(this.surface.detail(), undefined, undefined).item;
        return key !== undefined && this.item.isTranslating(key);
    }

    private seasonTranslating(): boolean {
        const key = descriptionTargets(this.surface.detail(), this.surface.season(), this.surface.episodes()).season;
        return key !== undefined && this.seasonRun.isTranslating(key);
    }

    private begin(automatic: boolean): void {
        const targets = descriptionTargets(this.surface.detail(), this.surface.season(), this.surface.episodes());
        this.cancelStale(this.item, targets.item);
        this.cancelStale(this.seasonRun, targets.season);
        if (targets.item !== undefined) {
            const key = targets.item;
            const fetch = (): Promise<ItemDetail | undefined> => this.readItem(key.contentId);
            const apply = (value: ItemDetail | readonly Episode[]): boolean => isItemDetail(value) ? this.surface.replaceDetail(value) : false;
            if (automatic) this.item.translateAutomatically(key, fetch, apply);
            else this.item.translate(key, fetch, apply);
        }
        if (targets.season !== undefined) {
            const key = targets.season;
            const season = this.surface.season();
            const seriesId = this.surface.seriesId();
            if (season !== undefined && seriesId !== undefined) {
                const fetch = (): Promise<readonly Episode[] | undefined> => this.readEpisodes(seriesId, season.number);
                const apply = (value: ItemDetail | readonly Episode[]): boolean => isItemDetail(value) ? false : this.surface.replaceEpisodes(season.number, value);
                if (automatic) this.seasonRun.translateAutomatically(key, fetch, apply);
                else this.seasonRun.translate(key, fetch, apply);
            }
        }
    }

    private cancelStale(coordinator: DescriptionTranslationCoordinator, key: TranslationKey | undefined): void {
        if (!coordinator.isRunning) return;
        if (coordinator.key?.contentId !== key?.contentId || coordinator.key?.targetLanguage !== key?.targetLanguage) coordinator.cancel();
    }

    private post(key: TranslationKey): Promise<DescriptionJob> {
        return this.session.call({ ...descriptionTranslationOperations.translateDescription(key.contentId, key.targetLanguage), profileScoped: true, signal: this.signal });
    }

    private async readItem(contentId: string): Promise<ItemDetail | undefined> {
        try {
            return await this.session.call({ ...operations.getCatalogItem(contentId), profileScoped: true, signal: this.signal });
        } catch (error) {
            if (error instanceof ApiError && error.aborted) throw error;
            return undefined;
        }
    }

    private async readEpisodes(seriesId: string, seasonNumber: number): Promise<readonly Episode[] | undefined> {
        try {
            return await this.session.call({ ...operations.listSeasonEpisodes(seriesId, seasonNumber), profileScoped: true, signal: this.signal });
        } catch (error) {
            if (error instanceof ApiError && error.aborted) throw error;
            return undefined;
        }
    }
}

/** The profile's metadata-AI mode, shared by the marquee and Details. */
export class DescriptionTranslations {
    readonly cards: CardDescriptionTranslation;
    private readonly session: NativeSession;
    private readonly clock: Clock;
    private mode: OnViewMode = "off";
    private loading: Promise<void> | undefined;
    private readonly modeListeners = new Set<() => void>();

    constructor(session: NativeSession, clock: Clock) {
        this.session = session;
        this.clock = clock;
        this.cards = new CardDescriptionTranslation(this, clock, (contentId) => this.readCard(contentId), (contentId, language) => this.post(contentId, language));
    }

    onView(): OnViewMode { return this.mode; }

    subscribeMode(listener: () => void): () => void {
        this.modeListeners.add(listener);
        return () => this.modeListeners.delete(listener);
    }

    ensure(): Promise<void> {
        if (this.loading === undefined) {
            this.loading = this.session.call({ ...descriptionTranslationOperations.metadataAI(), profileScoped: true }).then((status) => {
                this.mode = status.onView;
                this.emitMode();
            }, () => {
                this.mode = "off";
                this.emitMode();
            });
        }
        return this.loading;
    }

    reset(): void {
        this.cards.reset();
        this.mode = "off";
        this.loading = undefined;
        this.emitMode();
    }

    open(surface: DetailSurface): ItemDescriptionTranslation {
        return new ItemDescriptionTranslation(this, this.session, this.clock, surface);
    }

    private emitMode(): void {
        for (const listener of this.modeListeners) listener();
    }

    private post(contentId: string, language: string): Promise<DescriptionJob> {
        return this.session.call({ ...descriptionTranslationOperations.translateDescription(contentId, language), profileScoped: true });
    }

    private async readCard(contentId: string): Promise<ItemDetail | undefined> {
        try {
            return await this.session.call({ ...operations.getCatalogItem(contentId), profileScoped: true });
        } catch (error) {
            if (error instanceof ApiError && error.aborted) throw error;
            return undefined;
        }
    }
}
