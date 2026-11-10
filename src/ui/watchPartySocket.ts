// Apple's Watch Party room connection: WatchPartySocket (the silo.room.v2 socket), the connection loop in
// WatchPartySession.startConnection, WatchPartyRoomState (which room answer is current) and WatchPartyClock
// (the server's clock from ping and pong). One RoomConnection serves one open room until it is closed.

import { type Clock, sleep } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import { SessionError } from "../session/session.ts";
import {
    encodeRoomClientMessage, parseRoomServerMessage, type Room, type RoomAccess, type RoomClientMessage, type RoomServerMessage, type RoomSocketTicket, ROOM_SOCKET_PROTOCOL,
} from "../contracts/v2/watchTogether.ts";
import { WireError } from "../contracts/v2/wire.ts";

/** The parts of a browser WebSocket the room uses, so tests can pass a fake. */
export interface RoomWebSocket {
    readonly protocol: string;
    binaryType: BinaryType;
    onopen: ((event: Event) => void) | null;
    onmessage: ((event: MessageEvent) => void) | null;
    onclose: ((event: CloseEvent) => void) | null;
    onerror: ((event: Event) => void) | null;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}

export type RoomSocketFactory = (url: string, protocols: string[]) => RoomWebSocket;

export const browserSocket: RoomSocketFactory = (url, protocols) => new WebSocket(url, protocols);

/** What a connection asks the server for: the room read, a ticket, and the socket address that ticket opens. */
export interface RoomSocketApi {
    room(roomId: string, token: string, signal: AbortSignal): Promise<RoomAccess>;
    socketTicket(roomId: string, token: string, signal: AbortSignal): Promise<RoomSocketTicket>;
    socketHandshake(roomId: string, ticket: RoomSocketTicket): { readonly url: string; readonly protocols: readonly string[] };
}

/** WatchPartySession.Connection while a room is open. */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting";

/** Why the room ended for this viewer (WatchPartySession.terminate): closed by the server, gone or refused, or taken over by another device. */
export type RoomEnd = "ended" | "expired" | "replaced";

export interface RoomHandlers {
    /** The newest room token; every answer renews it. */
    token(): string;
    /** WatchPartyRoomState.receipt before the room read starts. */
    receipt(): number;
    /** The room read that opens every attempt, with the receipt from before it was sent. */
    access(answer: RoomAccess, receipt: number): void;
    /** Every frame but pong, which the connection's clock takes. */
    message(message: RoomServerMessage): void;
    status(status: ConnectionStatus): void;
    end(reason: RoomEnd): void;
}

export interface RoomConnectionDeps {
    readonly socket: RoomSocketFactory;
    readonly clock: Clock;
}

/**
 * WatchPartyRoomState: which room answer is current. A socket snapshot and an HTTP answer race, so an
 * older generation or selection revision is dropped, and a same-generation HTTP answer cannot replace
 * a snapshot that arrived after its request was sent.
 */
export class RoomState {
    room: Room | undefined;
    receipt = 0;
    terminal = false;

    accept(incoming: Room, requestReceipt?: number): boolean {
        if (this.terminal) return false;
        const room = this.room;
        if (room !== undefined) {
            if (room.roomId !== incoming.roomId || incoming.generation < room.generation || incoming.selectionRevision < room.selectionRevision) return false;
            if (requestReceipt !== undefined && incoming.generation === room.generation && this.receipt > requestReceipt) return false;
        }
        this.room = incoming;
        this.receipt++;
        this.terminal = incoming.phase === "ended";
        return true;
    }
}

interface ClockSample { readonly roundTrip: number; readonly offset: number }

/**
 * WatchPartyClock: the offset from this device's clock to the server's, from the fastest recent ping
 * round trip, whose error is smallest. Milliseconds throughout.
 */
export class RoomClock {
    static readonly SAMPLE_LIMIT = 8;
    static readonly MAX_ROUND_TRIP_MS = 5000;
    static readonly WARMUP_SAMPLES = 4;
    static readonly WARMUP_INTERVAL_MS = 2000;
    static readonly INTERVAL_MS = 15000;
    /** Millisecond timestamps can make a LAN round trip read slightly negative. */
    static readonly ROUNDING_SLACK_MS = 2;
    /** Beyond their error bounds, two offsets disagree by this much only when this device's clock moved. */
    static readonly STEP_MARGIN_MS = 50;

    private samples: ClockSample[] = [];

    get count(): number { return this.samples.length; }

    /** Server time minus local time, or 0 before any sample. */
    get offset(): number { return this.fastest()?.offset ?? 0; }

    /** Records a sample and returns whether it was usable. */
    record(clientSent: number, serverReceived: number, serverSent: number, clientReceived: number): boolean {
        let roundTrip = clientReceived - clientSent - (serverSent - serverReceived);
        if (roundTrip < 0 && roundTrip >= -RoomClock.ROUNDING_SLACK_MS) roundTrip = 0;
        if (!Number.isFinite(roundTrip) || roundTrip < 0 || roundTrip > RoomClock.MAX_ROUND_TRIP_MS) return false;
        const offset = (serverReceived - clientSent + (serverSent - clientReceived)) / 2;
        const best = this.fastest();
        // An offset that cannot agree with the best kept one means the device clock stepped, so the old samples are stale.
        if (best !== undefined && Math.abs(offset - best.offset) > (roundTrip + best.roundTrip) / 2 + RoomClock.STEP_MARGIN_MS) this.samples = [];
        this.samples.push({ roundTrip, offset });
        if (this.samples.length > RoomClock.SAMPLE_LIMIT) this.samples.shift();
        return true;
    }

    /** The fastest sample, the newest on a tie. */
    private fastest(): ClockSample | undefined {
        let best: ClockSample | undefined;
        for (const sample of this.samples) if (best === undefined || sample.roundTrip <= best.roundTrip) best = sample;
        return best;
    }
}

/** A socket that stayed open this long reconnects at once: the server ends every room socket at its connection deadline. */
export const STABLE_CONNECTION_MS = 30_000;
/** How often the open socket checks whether a ping is due, as Apple's report loop. */
const REPORT_TICK_MS = 500;
/** Apple closes with going-away or protocol-error; a page may only send 1000 or 3000 to 4999, or close() throws. */
const NORMAL_CLOSURE = 1000;

/** Apple's reconnect delay after the nth failure in a row: 1, 2, 4, 8, then 15 seconds. */
export function reconnectDelayMs(failures: number): number {
    return Math.min(15, 2 ** Math.min(failures - 1, 4)) * 1000;
}

class SocketClosed extends Error {}
class UnsupportedProtocol extends Error {}

const status = (error: unknown): number | undefined => error instanceof ApiError ? error.status : undefined;

/** WatchPartySession.isTerminalError, and the 409 that refuses an ended room. Anything else reconnects. */
export function roomEnd(error: unknown): RoomEnd | undefined {
    if (status(error) === 409) return "ended";
    const code = status(error);
    if (code !== undefined && [401, 403, 404, 410].includes(code)) return "expired";
    if (error instanceof ApiError && (error.failure.kind === "invalid_response" || error.failure.kind === "aborted")) return "expired";
    // A refresh the server cannot answer for now keeps the tokens and is retried, as any other outage.
    if (error instanceof SessionError && error.reason !== "unavailable") return "expired";
    if (error instanceof WireError || error instanceof UnsupportedProtocol) return "expired";
    return undefined;
}

export class RoomConnection {
    readonly clock = new RoomClock();
    private readonly controller = new AbortController();
    private readonly roomId: string;
    private readonly api: RoomSocketApi;
    private readonly handlers: RoomHandlers;
    private readonly deps: RoomConnectionDeps;
    /** The socket while it is open; frames are sent only on it. */
    private open: RoomWebSocket | undefined;

    constructor(roomId: string, api: RoomSocketApi, handlers: RoomHandlers, deps: RoomConnectionDeps) {
        this.roomId = roomId;
        this.api = api;
        this.handlers = handlers;
        this.deps = deps;
        void this.run();
    }

    /** Sends a frame on the open socket. False while connecting or reconnecting: the frame is dropped, as Apple's send. */
    send(message: RoomClientMessage): boolean {
        if (this.open === undefined || this.closed) return false;
        this.open.send(encodeRoomClientMessage(message));
        return true;
    }

    /** Leave, sign-out, profile switch or the room ending: the socket closes and nothing reconnects. */
    close(): void { this.controller.abort(); }

    private get closed(): boolean { return this.controller.signal.aborted; }

    private async run(): Promise<void> {
        const signal = this.controller.signal;
        let failures = 0;
        while (!this.closed) {
            this.handlers.status(failures === 0 ? "connecting" : "reconnecting");
            const attempt: { openedAt?: number } = {};
            try {
                const receipt = this.handlers.receipt();
                const answer = await this.api.room(this.roomId, this.handlers.token(), signal);
                if (this.closed) return;
                this.handlers.access(answer, receipt);
                if (this.closed) return;
                const ticket = await this.api.socketTicket(this.roomId, this.handlers.token(), signal);
                if (this.closed) return;
                await this.attach(ticket, attempt);
            } catch (error) {
                if (this.closed) return;
                const end = roomEnd(error);
                if (end !== undefined) { this.close(); this.handlers.end(end); return; }
            }
            if (this.closed) return;
            if (attempt.openedAt !== undefined && this.deps.clock.now() - attempt.openedAt >= STABLE_CONNECTION_MS) { failures = 0; continue; }
            failures++;
            this.handlers.status("reconnecting");
            try { await sleep(this.deps.clock, reconnectDelayMs(failures), signal, () => new SocketClosed()); } catch { return; }
        }
    }

    /** One socket, from the handshake to its close. Resolves when it closes, rejects when it cannot be used. */
    private attach(ticket: RoomSocketTicket, attempt: { openedAt?: number }): Promise<void> {
        const { url, protocols } = this.api.socketHandshake(this.roomId, ticket);
        const { clock } = this.deps;
        return new Promise<void>((resolve, reject) => {
            const socket = this.deps.socket(url, [...protocols]);
            socket.binaryType = "arraybuffer";
            let cancelTick: (() => void) | undefined;
            const finish = (error?: unknown): void => {
                socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
                if (this.open === socket) this.open = undefined;
                cancelTick?.();
                this.controller.signal.removeEventListener("abort", abort);
                if (error === undefined) resolve(); else reject(error);
            };
            const abort = (): void => { socket.close(NORMAL_CLOSURE); finish(); };
            this.controller.signal.addEventListener("abort", abort, { once: true });
            socket.onopen = () => {
                if (socket.protocol !== ROOM_SOCKET_PROTOCOL) { socket.close(NORMAL_CLOSURE); finish(new UnsupportedProtocol()); return; }
                attempt.openedAt = clock.now();
                this.open = socket;
                this.handlers.status("connected");
                if (this.closed) return;
                // Pings run fast until this socket has a few clock samples, then slowly; a clock step discards samples and warms up again.
                let samples = 0;
                let lastPing = -Infinity;
                const tick = (): void => {
                    const now = clock.now();
                    const warming = Math.min(samples, this.clock.count) < RoomClock.WARMUP_SAMPLES;
                    if (now - lastPing >= (warming ? RoomClock.WARMUP_INTERVAL_MS : RoomClock.INTERVAL_MS)) {
                        lastPing = now;
                        socket.send(encodeRoomClientMessage({ type: "ping", clientSentAt: now }));
                    }
                    cancelTick = clock.schedule(tick, REPORT_TICK_MS);
                };
                socket.onmessage = event => {
                    const receivedAt = clock.now();
                    let message: RoomServerMessage;
                    try {
                        message = parseRoomServerMessage(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
                    } catch (error) {
                        socket.close(NORMAL_CLOSURE);
                        finish(error);
                        return;
                    }
                    if (message.type === "pong") {
                        if (this.clock.record(message.clientSentAt, message.serverReceivedAt, message.serverSentAt, receivedAt)) samples++;
                    } else this.handlers.message(message);
                };
                tick();
            };
            // A refused handshake reports an error, then closes; the close settles the attempt either way.
            socket.onclose = () => { finish(new SocketClosed()); };
        });
    }
}
