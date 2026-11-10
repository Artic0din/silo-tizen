// Playback → Connection. Labels and states match SettingsViewModel.swift:572-745
// and the tvOS row in TVPlaybackSettingsView.swift:127-169 at silo-apple 2ef3a171.
// The accurate probe runs only from Test speed. Opening Settings reads the stored
// connection; focusing the row does not.

import type { NativeSession } from "../session/session.ts";
import { systemClock } from "../api/clock.ts";
import { operations } from "../api/operations.ts";
import { runManualSpeedTest, type ManualSpeedTestResult, type ProbeTransportName, type SpeedMeasurement, type SpeedTestClient, type SpeedTestNetwork } from "../api/bandwidthProbe.ts";
import { bandwidthReadings, readingsKey } from "../player/bandwidthReadings.ts";
import { BUFFERING_QUALITY_FEATURE, CONNECTION_SPEED_FEATURE, type ConnectionProbe, type ConnectionSample, type LearnedLimit, type PlaybackConnection } from "../contracts/v2/connectionSpeed.ts";

export const CONNECTION_SECTION = "CONNECTION";
export const CONNECTION_SPEED_TITLE = "Connection speed";
export const TEST_SPEED_ACTION = "Test speed";
export const TESTING_SPEED_LABEL = "Testing…";
export const NOT_MEASURED_TEXT = "Not measured yet";
export const SPEED_TEST_FAILED = "Couldn't measure the connection speed. Try again.";
export const SPEED_TEST_NOT_SAVED = "Couldn't save the speed test result. Try again.";
export const LEARNED_LIMIT_RESET_FAILED = "Couldn't reset the limit. Try again.";
export const LEARNED_LIMIT_RESET_ACTION = "Reset";

export interface ConnectionSpeedView {
    readonly line: string;
    readonly action: string | undefined;
    readonly budget: string | undefined;
    readonly message: string | undefined;
    readonly disabled: boolean;
    readonly testing: boolean;
}

/** tvOS `offersCellularQuality` is false, so a metered network uses the shorter sentence. */
export function connectionSpeedSkippedText(network: SpeedTestNetwork & { readonly cellular: boolean }): string | undefined {
    if (!network.online || !network.metered) return undefined;
    if (network.cellular) return "Speed tests are skipped on cellular, and the Cellular Quality settings apply.";
    return "Speed tests are skipped on metered networks.";
}

/** SettingsViewModel.connectionRateText. Rounded down, no digit grouping. */
export function connectionRateText(kbps: number): string {
    const rate = Math.max(kbps, 0);
    if (rate < 1_000) return `${rate} kbps`;
    if (rate >= 10_000) return `${Math.floor(rate / 1_000)} Mbps`;
    const tenths = Math.floor(rate / 100);
    return tenths % 10 === 0 ? `${Math.floor(tenths / 10)} Mbps` : `${Math.floor(tenths / 10)}.${tenths % 10} Mbps`;
}

export function connectionAgeText(measuredAt: number, now: number): string {
    const minutes = Math.max(0, Math.floor((now - measuredAt) / 60_000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
    if (minutes < 24 * 60) {
        const hours = Math.floor(minutes / 60);
        return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
    }
    const days = Math.floor(minutes / (24 * 60));
    return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * "Limited to 44 Mbps after buffering on Oct 17": the rate as Settings shows rates and the day of the most
 * recent lowering in the viewer's locale and time zone (SettingsViewModel.learnedLimitText, 486-495).
 */
export function learnedLimitText(limit: LearnedLimit, locale?: string, timeZone?: string): string {
    const day = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...(timeZone === undefined ? {} : { timeZone }) }).format(limit.observedAt);
    return `Limited to ${connectionRateText(limit.kbps)} after buffering on ${day}`;
}

export function tryAgainMessage(seconds: number): string {
    return `Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

export function connectionSpeedText(kbps: number, lowerBound: boolean, measuredAt: number, transport: string, now: number): string {
    const network = transport === "wifi" ? "Wi-Fi" : transport === "ethernet" ? "Ethernet" : transport === "cellular" ? "cellular" : "this connection";
    const speed = lowerBound ? `Faster than ${connectionRateText(kbps)}` : connectionRateText(kbps);
    return `${speed} · measured ${connectionAgeText(measuredAt, now)} on ${network}`;
}

export function playbackSampleText(kbps: number, measuredAt: number, now: number): string {
    return `Faster than ${connectionRateText(kbps)} · seen during playback ${connectionAgeText(measuredAt, now)}`;
}

export function autoBudgetText(kbps: number): string {
    return `Auto plays videos up to ${connectionRateText(kbps)} without converting them.`;
}

export function currentNetwork(): SpeedTestNetwork & { readonly cellular: boolean } {
    const online = typeof navigator === "undefined" ? true : navigator.onLine;
    const connection = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { readonly connection?: { readonly type?: string; readonly saveData?: boolean } }).connection;
    const type = connection?.type;
    const cellular = type === "cellular";
    const transport: ProbeTransportName = type === "wifi" || type === "ethernet" || type === "cellular" ? type : "other";
    return { online, metered: cellular || connection?.saveData === true, cellular, transport };
}

/**
 * The Connection group for one Settings visit. The stored reading is loaded when
 * Settings opens. Test speed is the only path that downloads the probe.
 */
export class ConnectionSpeed {
    private supported = false;
    private learnedSupported = false;
    private resetting = false;
    /** The Auto limit the server learned for this device on this connection; absent without `buffering_quality_v1`. */
    learnedLimit: LearnedLimit | undefined;
    /** Set when Reset failed, until the next Reset or read. */
    learnedResetError: string | undefined;
    private connectionId: string | undefined;
    private serverProbe: ConnectionProbe | undefined;
    private sample: ConnectionSample | undefined;
    private autoBudgetKbps: number | undefined;
    private own: SpeedMeasurement | undefined;
    private unsavedAt: number | undefined;
    private message: string | undefined;
    private testing = false;
    private watching = false;
    private generation = 0;
    private readonly loadAbort = new AbortController();
    private testAbort: AbortController | undefined;
    private ageTimer: ReturnType<typeof setInterval> | undefined;
    private messageTimer: ReturnType<typeof setTimeout> | undefined;
    view: ConnectionSpeedView | undefined;
    private readonly session: NativeSession;
    private readonly onChange: () => void;

    constructor(session: NativeSession, onChange: () => void) {
        this.session = session;
        this.onChange = onChange;
    }

    /** One read for this visit. Focusing Playback does not call this again. */
    start(): void {
        void this.load(this.generation);
    }

    stop(): void {
        this.generation += 1;
        this.loadAbort.abort();
        this.testAbort?.abort();
        this.testAbort = undefined;
        this.testing = false;
        this.clearTimers();
    }

    /** The Playback pane is on screen. Restarts nothing and downloads nothing. */
    watch(): void {
        const entered = !this.watching;
        this.watching = true;
        if (this.ageTimer === undefined) {
            this.ageTimer = setInterval(() => {
                if (this.watching) this.refresh();
            }, 60_000);
        }
        if (entered) this.view = this.compose();
    }

    /**
     * Leaving Playback cancels an in-flight test. A cancelled test is not a failure.
     * The view is updated here without painting: the caller is already drawing another pane.
     */
    unwatch(): void {
        if (!this.watching) return;
        this.watching = false;
        if (this.ageTimer !== undefined) {
            clearInterval(this.ageTimer);
            this.ageTimer = undefined;
        }
        const abort = this.testAbort;
        this.testAbort = undefined;
        this.testing = false;
        abort?.abort();
        this.view = this.compose();
    }

    test(): void {
        if (this.testing || this.view === undefined || this.view.disabled) return;
        const abort = new AbortController();
        this.testAbort = abort;
        this.testing = true;
        this.message = undefined;
        this.clearMessageTimer();
        this.refresh();
        void runManualSpeedTest(this.client(), currentNetwork(), abort.signal).then((result) => {
            if (abort.signal.aborted || this.testAbort !== abort) return;
            this.testing = false;
            this.apply(result);
        }, () => {
            if (abort.signal.aborted || this.testAbort !== abort) return;
            this.testing = false;
            this.message = SPEED_TEST_FAILED;
            this.refresh();
        });
    }

    private client(): SpeedTestClient {
        const session = this.session;
        return {
            base: session.http.base,
            clock: systemClock,
            capabilities: (signal) => session.call({ ...operations.playbackCapabilities(), profileScoped: true, signal }),
            download: (url, signal) => session.authorizedFetch(url, signal),
            report: (body) => session.call({ ...operations.reportBandwidthProbe(body), profileScoped: true, replayAfterRefresh: false }),
        };
    }

    private async load(generation: number): Promise<void> {
        const signal = this.loadAbort.signal;
        try {
            const capabilities = await this.session.call({ ...operations.playbackCapabilities(), profileScoped: true, signal });
            if (generation !== this.generation || signal.aborted) return;
            this.learnedResetError = undefined;
            this.supported = capabilities.features.includes(CONNECTION_SPEED_FEATURE);
            this.learnedSupported = capabilities.features.includes(BUFFERING_QUALITY_FEATURE);
            if (!this.supported && !this.learnedSupported) {
                this.learnedLimit = undefined;
                this.refresh();
                return;
            }
            try {
                const connection = await this.session.call({ ...operations.playbackConnection(), profileScoped: true, signal });
                if (generation !== this.generation || signal.aborted) return;
                this.applyConnection(connection);
            } catch {
                if (generation !== this.generation || signal.aborted) return;
                // SettingsViewModel.swift:521-526: a missed read clears the server's figures and the row stays.
                this.serverProbe = undefined;
                this.sample = undefined;
                this.autoBudgetKbps = undefined;
                this.learnedLimit = undefined;
            }
            this.refresh();
        } catch {
            if (generation !== this.generation || signal.aborted) return;
            this.supported = false;
            this.learnedSupported = false;
            this.learnedLimit = undefined;
            this.refresh();
        }
    }

    private applyConnection(connection: PlaybackConnection): void {
        if (this.connectionId !== undefined && this.connectionId !== connection.connection) this.own = undefined;
        this.connectionId = connection.connection;
        this.learnedLimit = this.learnedSupported ? connection.learnedLimit : undefined;
        // Without connection_speed_v1 the speed members are not Settings' to show or to start with (SettingsViewModel.swift:521-526).
        if (!this.supported) return;
        this.serverProbe = connection.probe;
        this.sample = connection.playbackSample;
        this.autoBudgetKbps = connection.autoBudgetKbps;
        bandwidthReadings.adopt(this.readingsKey(), {
            ...(connection.probe === undefined ? {} : { probe: { kbps: connection.probe.kbps, measuredAt: connection.probe.measuredAt } }),
            ...(connection.playbackSample === undefined ? {} : { sample: connection.playbackSample }),
        });
    }

    /**
     * DELETE the learned limit. Resolves true once it is cleared; the caller then moves focus off the row
     * before it vanishes. A failure keeps the row, sets `learnedResetError` and repaints.
     * SettingsViewModel.resetLearnedConnectionLimit, 531-545.
     */
    async resetLearnedLimit(): Promise<boolean> {
        if (this.resetting || this.learnedLimit === undefined) return false;
        this.resetting = true;
        this.learnedResetError = undefined;
        const signal = this.loadAbort.signal;
        try {
            await this.session.call({ ...operations.resetPlaybackLearnedLimit(), profileScoped: true, replayAfterRefresh: false, signal });
            if (signal.aborted) return false;
            this.learnedLimit = undefined;
            // The server's Auto budget counted the limit, so the Connection group reads again.
            if (this.supported) void this.load(++this.generation);
            return true;
        } catch {
            if (signal.aborted) return false;
            this.learnedResetError = LEARNED_LIMIT_RESET_FAILED;
            this.onChange();
            return false;
        } finally {
            this.resetting = false;
        }
    }

    private readingsKey(): string {
        return readingsKey(this.session.http.base.baseUrl, this.session.account?.id, currentNetwork().transport);
    }

    private apply(result: ManualSpeedTestResult): void {
        switch (result.kind) {
            case "measured":
                this.unsavedAt = undefined;
                this.own = result.measurement;
                bandwidthReadings.adoptMeasured(this.readingsKey(), result.measurement);
                this.message = undefined;
                this.refresh();
                void this.load(++this.generation);
                return;
            case "notSaved":
                this.unsavedAt = result.measurement.measuredAt;
                this.own = result.measurement;
                this.message = SPEED_TEST_NOT_SAVED;
                this.refresh();
                void this.load(++this.generation);
                return;
            case "rateLimited":
                this.message = tryAgainMessage(result.seconds);
                this.clearMessageTimer();
                this.messageTimer = setTimeout(() => {
                    this.messageTimer = undefined;
                    this.message = undefined;
                    this.refresh();
                }, result.seconds * 1000);
                this.refresh();
                return;
            case "metered":
                this.refresh();
                return;
            case "failed":
                this.message = SPEED_TEST_FAILED;
                this.refresh();
                return;
            case "cancelled":
                this.refresh();
                return;
            default: {
                const never: never = result;
                throw new Error(never);
            }
        }
    }

    private refresh(): void {
        this.view = this.compose();
        this.onChange();
    }

    private compose(): ConnectionSpeedView | undefined {
        if (!this.supported) return undefined;
        const skipped = connectionSpeedSkippedText(currentNetwork());
        const now = Date.now();
        return {
            line: skipped ?? this.line(now),
            action: skipped !== undefined ? undefined : this.testing ? TESTING_SPEED_LABEL : TEST_SPEED_ACTION,
            budget: skipped !== undefined || this.autoBudgetKbps === undefined ? undefined : autoBudgetText(this.autoBudgetKbps),
            message: this.message,
            disabled: skipped !== undefined,
            testing: this.testing,
        };
    }

    private line(now: number): string {
        const server = this.serverProbe;
        const own = this.own;
        if (own !== undefined && own.measuredAt !== this.unsavedAt && (server === undefined || own.measuredAt >= server.measuredAt)) {
            return connectionSpeedText(own.kbps, own.lowerBound, own.measuredAt, own.transport, now);
        }
        if (server !== undefined) return connectionSpeedText(server.kbps, server.lowerBound, server.measuredAt, server.transport, now);
        if (this.sample !== undefined) return playbackSampleText(this.sample.kbps, this.sample.measuredAt, now);
        return NOT_MEASURED_TEXT;
    }

    private clearMessageTimer(): void {
        if (this.messageTimer === undefined) return;
        clearTimeout(this.messageTimer);
        this.messageTimer = undefined;
    }

    private clearTimers(): void {
        this.clearMessageTimer();
        if (this.ageTimer !== undefined) clearInterval(this.ageTimer);
        this.ageTimer = undefined;
    }
}
