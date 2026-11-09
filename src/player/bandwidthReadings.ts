// The stored speed readings a playback start may send as bandwidth_estimate_kbps.
// silo-apple BandwidthProbeScheduler.swift adopt, currentReadings and freshEstimateKbps at 27cf4a24.
// Nothing here probes or reads the server: Settings loads the connection document and Test speed
// measures, and both leave their readings here so a start costs no extra request.

export interface BandwidthReading {
    readonly kbps: number;
    readonly measuredAt: number;
}

export interface StoredReadings {
    readonly probe?: BandwidthReading;
    readonly sample?: BandwidthReading;
}

/** A server's `bandwidth_probe_max_age_seconds` when it sends none. LiveBandwidthProbeServer.fallbackMaxAge. */
export const FALLBACK_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Whose readings these are: a server, over the network in use. */
export function readingsKey(baseUrl: string, transport: string): string {
    return `${baseUrl} ${transport}`;
}

export class BandwidthReadings {
    private key: string | undefined;
    private probe: BandwidthReading | undefined;
    private sample: BandwidthReading | undefined;

    /** The server's connection document. Keeps the newer probe, the server's or this device's own. */
    adopt(key: string, stored: StoredReadings): void {
        if (this.key !== key) this.probe = undefined;
        this.key = key;
        if (stored.probe !== undefined && stored.probe.measuredAt >= (this.probe?.measuredAt ?? Number.NEGATIVE_INFINITY)) this.probe = stored.probe;
        this.sample = stored.sample;
    }

    /** A Test speed result the server stored. The server clears its playback sample then, so an older, higher one cannot outvote it. */
    adoptMeasured(key: string, reading: BandwidthReading): void {
        this.key = key;
        this.sample = undefined;
        this.probe = reading;
    }

    /**
     * The highest reading younger than `maxAgeSeconds` for `key`. A reading dated after `now` is as fresh as now:
     * the server dates it by its own clock.
     */
    freshEstimateKbps(key: string, now: number, maxAgeSeconds: number): number | undefined {
        if (this.key !== key) return undefined;
        let highest: number | undefined;
        for (const reading of [this.probe, this.sample]) {
            if (reading === undefined || Math.max(0, now - reading.measuredAt) >= maxAgeSeconds * 1000) continue;
            highest = Math.max(highest ?? reading.kbps, reading.kbps);
        }
        return highest;
    }

    clear(): void {
        this.key = undefined;
        this.probe = undefined;
        this.sample = undefined;
    }
}

export const bandwidthReadings = new BandwidthReadings();
