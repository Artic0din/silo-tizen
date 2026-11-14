// Profile settings that change how titles and cards look: title art (`ui.title_art`) and poster
// badges (`ui.card_overlays`, `ui.card_overlays_enabled` and `/settings/overlay-config`). Read-only.
// Home and Details follow silo-apple 1a7cceeaf3b2bfc4f889c00487d19b2c6f843940:
// - `Networking/TitleArtPreferences.swift`: logos show unless the server's last confirmed answer for
//   this server and profile says off. That answer is kept on the TV, so a failed or pending read keeps
//   it, and a server without the key drops it.
// - `Networking/OverlayPrefsStore.swift`: the profile's document wins outright, else the
//   administrator's baseline, else the registry defaults; the profile's on/off choice wins over the
//   server-wide default in either direction. Registry defaults show until the reads answer, and a
//   failed half keeps that half's last answer.
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import { CARD_OVERLAYS_ENABLED_KEY, CARD_OVERLAYS_KEY, CARD_PRESENTATION_KEY, type EffectiveSetting, profileSettings, type SettingsCapabilities, type SettingsKey, TITLE_ART_KEY } from "../contracts/v2/settings.ts";
import type { PublicStorage } from "../session/deviceIdentity.ts";
import type { NativeSession } from "../session/session.ts";
import { type CardOverlayPrefs, parseOverlayPrefs } from "./cardOverlays.ts";

type Read = <T>(spec: RequestSpec<T>) => Promise<T>;

/** Undefined for a server without the settings API (404 or 501). */
export async function readSettingsCapability(read: Read): Promise<SettingsCapabilities | undefined> {
    try { return await read(operations.settingsCapabilities()); }
    catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 501)) return undefined;
        throw error;
    }
}

/**
 * The title-art answer for this profile on this TV: `"compatibility"` for a server older than the key,
 * the effective boolean otherwise, undefined without an active profile. Throws when the settings
 * cannot be read or a row is missing or malformed.
 */
export async function readTitleArt(read: Read, session: NativeSession, capability: SettingsCapabilities | undefined): Promise<"compatibility" | boolean | undefined> {
    if (capability === undefined) return "compatibility";
    if (capability.apiVersion !== 1 || capability.state !== "available" || !capability.allowed) throw new Error("Title-art settings unavailable");
    if (capability.manifestRevision < 16) return "compatibility";
    const contract = await read(operations.settingsContract());
    if (contract.revision < capability.manifestRevision || !profileSettings(contract, capability).some(def => def.key === TITLE_ART_KEY)) throw new Error("Incompatible title-art definition");
    const profile = session.activeProfile;
    if (profile === undefined) return undefined;
    const effective = await read(operations.effectiveSettings([TITLE_ART_KEY], { profileId: profile.id, deviceId: session.http.deviceId, manifestRevision: contract.revision }));
    const value = effective.get(TITLE_ART_KEY)?.value;
    if (typeof value !== "boolean") throw new Error("Missing title-art boolean");
    return value;
}

/** `ui.card_overlays_enabled` arrived at manifest revision 8; an older server cannot answer either key. */
const OVERLAY_KEYS_REVISION = 8;

/**
 * The profile's own badge choices; undefined when it has not chosen. `"unsupported"` when the server
 * cannot answer either key (Apple's update-required answer, which counts as no choice).
 */
async function readProfileOverlays(read: Read, capability: SettingsCapabilities | undefined): Promise<"unsupported" | { document: unknown; enabled: boolean | undefined }> {
    if (capability === undefined || capability.manifestRevision < OVERLAY_KEYS_REVISION) return "unsupported";
    if (capability.apiVersion !== 1 || capability.state !== "available" || !capability.allowed) throw new Error("Badge settings unavailable");
    const keys: SettingsKey[] = [CARD_OVERLAYS_KEY, CARD_OVERLAYS_ENABLED_KEY];
    const effective = capability.supportsBatchedEffective
        ? await read(operations.effectiveSettings(keys))
        : new Map((await Promise.all(keys.map(key => read(operations.effectiveSettings([key]))))).flatMap(map => [...map]));
    // Only a profile row is a choice; the contract default (null) leaves the server-wide answer in charge.
    const chosen = (key: SettingsKey): EffectiveSetting | undefined => { const row = effective.get(key); return row?.source === "profile" && row.value !== null ? row : undefined; };
    const enabled = chosen(CARD_OVERLAYS_ENABLED_KEY)?.value;
    return { document: chosen(CARD_OVERLAYS_KEY)?.value, enabled: typeof enabled === "boolean" ? enabled : undefined };
}

function prefsKey(prefs: CardOverlayPrefs): string {
    return JSON.stringify([prefs.preset, prefs.order, [...prefs.items]]);
}

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };
const settle = <T>(work: Promise<T>): Promise<Settled<T>> => work.then(value => ({ ok: true, value }), () => ({ ok: false }));

/** Loads once per Browse (Browse lives for one server and profile), notifying `changed` when what Home draws changes. */
export class PresentationSettings {
    /** The last answer the server confirmed for this server and profile; undefined means none applies. */
    private titleArt: boolean | undefined;
    private titleArtAnswered = false;
    private scale = 1;
    private posterAnswered = false;
    private serverEnabled = true;
    private profileEnabled: boolean | undefined;
    private adminDefaults: string | undefined;
    private prefs: CardOverlayPrefs = parseOverlayPrefs(undefined);
    private overlaysHydrated = false;
    private controller: AbortController | undefined;
    private readonly session: NativeSession;
    private readonly changed: () => void;
    private readonly storage: PublicStorage | undefined;
    private readonly storageKey: string;

    constructor(session: NativeSession, changed: () => void, storage: PublicStorage | undefined, storageKey: string) {
        this.session = session;
        this.changed = changed;
        this.storage = storage;
        this.storageKey = storageKey;
        let cached: string | null | undefined;
        try { cached = storage?.getItem(storageKey); }
        catch { /* An unavailable optional cache must not block Browse. */ }
        this.titleArt = cached === "true" ? true : cached === "false" ? false : undefined;
        try {
            const size = storage?.getItem(`${storageKey}:cards`);
            this.scale = size === "0.86" ? 0.86 : size === "1.2" ? 1.2 : 1;
        } catch { /* Optional storage cannot prevent Home from loading. */ }
    }

    /** Whether a title's logo may replace its text title: on unless the last confirmed answer is off. */
    get showsTitleArt(): boolean { return this.titleArt ?? true; }
    get posterScale(): number { return this.scale; }

    /** The badge document cards draw, or undefined while badges are off. */
    get cardOverlays(): CardOverlayPrefs | undefined { return (this.profileEnabled ?? this.serverEnabled) ? this.prefs : undefined; }

    /** Starts the reads unless they are in flight or both answered; a failed half retries. */
    ensure(): void {
        if (this.controller === undefined && (!this.titleArtAnswered || !this.overlaysHydrated || !this.posterAnswered)) this.load();
    }

    /** The title-art answer Settings just confirmed, kept before the reread lands so no page shows the old one. */
    acceptTitleArt(value: boolean): void {
        this.applyTitleArt(value, () => true);
    }

    /** Rereads both answers, as after the person leaves Settings. The last answers stay until new ones land. */
    reload(): void {
        this.load();
    }

    private load(): void {
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        const read: Read = spec => this.session.call({ ...spec, profileScoped: true, signal: controller.signal });
        const current = (): boolean => this.controller === controller && !controller.signal.aborted;
        const capability = readSettingsCapability(read);
        const titleArt = capability.then(async found => this.applyTitleArt(await readTitleArt(read, this.session, found), current), () => undefined);
        const posters = capability.then(async found => {
            if (found !== undefined && (found.apiVersion !== 1 || found.state !== "available" || !found.allowed)) throw new Error("Card settings unavailable");
            let scale = 1;
            if (found !== undefined && found.manifestRevision >= 5 && found.supportsBatchedEffective && found.supportsAtomicShortcuts && found.clientFamilies.includes("tv")) {
                const values = await read({ ...operations.effectiveSettings([CARD_PRESENTATION_KEY]), clientFamily: "tv" });
                const value = values.get(CARD_PRESENTATION_KEY)?.value;
                if (value === null || typeof value !== "object" || Array.isArray(value) || !("poster_size" in value)) throw new Error("Missing card presentation");
                scale = value.poster_size === "compact" ? 0.86 : value.poster_size === "large" ? 1.2 : 1;
            }
            if (!current()) return;
            const before = this.scale;
            this.scale = scale;
            this.posterAnswered = true;
            try { this.storage?.setItem(`${this.storageKey}:cards`, String(scale)); } catch { /* Keep the successful in-memory answer. */ }
            if (before !== scale) this.changed();
        });
        const overlays = Promise.all([settle(read(operations.overlayConfig())), settle(capability.then(found => readProfileOverlays(read, found)))])
            .then(([config, profile]) => { if (current()) this.applyOverlays(config, profile); });
        void Promise.all([titleArt.catch(() => undefined), posters.catch(() => undefined), overlays]).then(() => { if (this.controller === controller) this.controller = undefined; });
    }

    private applyTitleArt(answer: "compatibility" | boolean | undefined, current: () => boolean): void {
        if (!current() || answer === undefined) return;
        const before = this.showsTitleArt;
        // A server without the key drops the remembered answer, so every title shows its logo again.
        this.titleArt = answer === "compatibility" ? undefined : answer;
        try {
            if (this.titleArt === undefined) this.storage?.removeItem(this.storageKey);
            else this.storage?.setItem(this.storageKey, String(this.titleArt));
        } catch { /* The confirmed in-memory answer remains authoritative without persistence. */ }
        this.titleArtAnswered = true;
        if (before !== this.showsTitleArt) this.changed();
    }

    private applyOverlays(config: Settled<{ enabled: boolean; defaults: string | undefined }>, profile: Settled<"unsupported" | { document: unknown; enabled: boolean | undefined }>): void {
        const before = this.cardOverlays;
        // A failed read keeps that half's last answer rather than re-enabling what the administrator turned off.
        if (config.ok) { this.serverEnabled = config.value.enabled; this.adminDefaults = config.value.defaults; }
        const choice = profile.ok ? profile.value === "unsupported" ? { document: undefined, enabled: undefined } : profile.value : undefined;
        if (choice !== undefined) {
            this.profileEnabled = choice.enabled;
            const prefs = parseOverlayPrefs(choice.document ?? this.adminDefaults);
            if (prefsKey(prefs) !== prefsKey(this.prefs)) this.prefs = prefs;
        }
        this.overlaysHydrated = config.ok && profile.ok && profile.value !== "unsupported";
        if (before !== this.cardOverlays) this.changed();
    }

    stop(): void {
        this.controller?.abort();
        this.controller = undefined;
    }
}
