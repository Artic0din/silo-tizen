import type { Clock } from "../../../src/api/clock.ts";

/** Lets a test move time forward and runs every timer that falls due, in order. */
export class ManualClock implements Clock {
    private time: number;
    private nextId = 0;
    private timers: { id: number; at: number; fn: () => void }[] = [];

    constructor(start = Date.parse("2026-01-02T03:04:05.678Z")) {
        this.time = start;
    }

    now(): number {
        return this.time;
    }

    schedule(fn: () => void, ms: number): () => void {
        const id = this.nextId++;
        this.timers.push({ id, at: this.time + Math.max(0, ms), fn });
        return () => {
            this.timers = this.timers.filter((timer) => timer.id !== id);
        };
    }

    async advance(ms: number): Promise<void> {
        const target = this.time + ms;
        for (;;) {
            await settle();
            const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
            if (due === undefined) {
                break;
            }
            this.timers = this.timers.filter((timer) => timer.id !== due.id);
            this.time = Math.max(this.time, due.at);
            due.fn();
        }
        this.time = target;
        await settle();
    }
}

/** Lets pending promise chains (fake fetches, storage) run to their next wait. */
export async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}
