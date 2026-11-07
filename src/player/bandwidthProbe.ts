// Accurate connection-speed measurement. Test speed only.
// BandwidthProbe.swift:11-29, 83-226 at silo-apple 2ef3a171.
// Window 0 is ramp-up and never counts. A settled rate is floor(bytes × 8 / ms)
// over the last complete windows after window 0, up to six (3 000 ms).

/** `PROBE_WINDOW_MS`. BandwidthProbe.swift:12. */
export const PROBE_WINDOW_MS = 500;
/** `ACCURATE_PROBE_BYTES`. BandwidthProbe.swift:19. */
export const ACCURATE_PROBE_BYTES = 1_000_000_000;
/** `ACCURATE_PROBE_MAX_MS`. BandwidthProbe.swift:20. */
export const ACCURATE_PROBE_MAX_MS = 10_000;
/** `ACCURATE_SETTLE_WINDOWS`. BandwidthProbe.swift:21. */
export const ACCURATE_SETTLE_WINDOWS = 6;
/** `PROBE_FIRST_BYTE_DEADLINE_MS`. BandwidthProbe.swift:24. */
export const PROBE_FIRST_BYTE_DEADLINE_MS = 10_000;
/** `MIN_PROBE_KBPS` / `MAX_PROBE_KBPS`. BandwidthProbe.swift:26-29. */
export const MIN_PROBE_KBPS = 100;
export const MAX_PROBE_KBPS = 1_000_000;

export interface ProbeMeterResult {
    readonly kbps: number;
    readonly lowerBound: boolean;
    readonly bytes: number;
    readonly durationMs: number;
}

/** Times one accurate download. The clock is milliseconds after the first byte. */
export class AccurateProbeMeter {
    private windowBytes: number[] = [];
    private receivedBytes = 0;
    private transferDidEnd = false;
    private closedWindows = 0;
    private stoppedAt: number | undefined;

    /** True once the test has stopped. Bytes after that do not count. */
    advance(t: number): boolean {
        if (this.stoppedAt !== undefined) return true;
        const now = Math.min(t, ACCURATE_PROBE_MAX_MS);
        while ((this.closedWindows + 1) * PROBE_WINDOW_MS <= now) this.closedWindows += 1;
        if (t >= ACCURATE_PROBE_MAX_MS) {
            this.stoppedAt = ACCURATE_PROBE_MAX_MS;
            return true;
        }
        return false;
    }

    receive(bytes: number, t: number): void {
        if (this.advance(t)) return;
        const window = Math.floor(t / PROBE_WINDOW_MS);
        while (this.windowBytes.length <= window) this.windowBytes.push(0);
        const current = this.windowBytes[window] ?? 0;
        this.windowBytes[window] = current + bytes;
        this.receivedBytes += bytes;
    }

    /** A clean end. A window it cuts short does not count. */
    transferEnded(t: number): void {
        if (this.advance(t)) return;
        this.stoppedAt = t;
        this.transferDidEnd = true;
    }

    /** Undefined when the test measured nothing. BandwidthProbe.swift:181-199. */
    get result(): ProbeMeterResult | undefined {
        if (this.stoppedAt === undefined) return undefined;
        const complete = this.closedWindows - 1;
        if (complete <= 0) return this.wholeTransfer();
        const count = Math.min(ACCURATE_SETTLE_WINDOWS, complete);
        let bytes = 0;
        for (let window = this.closedWindows - count; window < this.closedWindows; window += 1) {
            bytes += this.windowBytes[window] ?? 0;
        }
        const durationMs = count * PROBE_WINDOW_MS;
        const kbps = Math.floor((bytes * 8) / durationMs);
        if (kbps < MIN_PROBE_KBPS) return undefined;
        if (kbps > MAX_PROBE_KBPS) return { kbps: MAX_PROBE_KBPS, lowerBound: true, bytes, durationMs };
        return { kbps, lowerBound: false, bytes, durationMs };
    }

    /**
     * Every requested byte arrived before a window after window 0 completed.
     * The ramp is inside the average, so the result is a lower bound.
     */
    private wholeTransfer(): ProbeMeterResult | undefined {
        if (!this.transferDidEnd || this.receivedBytes < ACCURATE_PROBE_BYTES) return undefined;
        const durationMs = this.stoppedAt;
        if (durationMs === undefined || durationMs <= 0) return undefined;
        const kbps = Math.floor((this.receivedBytes * 8) / durationMs);
        return {
            kbps: Math.min(kbps, MAX_PROBE_KBPS),
            lowerBound: true,
            bytes: this.receivedBytes,
            durationMs,
        };
    }
}
