import type { MediaRequest, MyRequests, RequestsHub } from "../contracts/v2/requests.ts";
import type { FocusTarget } from "./browseFocus.ts";
import { orderRequests, requestProgress } from "./requestProgress.ts";

/** Apple RequestErrorCopy.removedNotice. */
export const REMOVED_NOTICE = "Request removed";
/** Apple RequestErrorCopy.unconfirmedRemoveMessage. */
export const UNCONFIRMED_REMOVE_MESSAGE = "We couldn't confirm the removal. Reopen My Requests to check it.";
/** Apple RequestErrorCopy.removeConflictMessage. */
export const REMOVE_CONFLICT_MESSAGE = "This request changed since the list loaded, so it wasn't removed.";
/** Apple RequestErrorCopy.unconfirmedCancelMessage. */
export const UNCONFIRMED_CANCEL_MESSAGE = "We couldn't confirm the cancellation. Reopen My Requests to check it.";
/** Apple MyRequestsViewModel clears a notice after three seconds. */
export const REQUEST_NOTICE_MS = 3000;

/** Apple MediaRequest.isRemovable: failed, and no target already completed. */
export function isRemovable(record: MediaRequest): boolean {
    return record.outcome === "failed" && !(record.targets ?? []).some(target => target.status === "completed");
}

/** Apple RequestDisplayState.isCancelable: a pending request, and only that. */
export function isCancelable(record: MediaRequest): boolean {
    return requestProgress(record)?.display === "pending";
}

/** No list action is running, and this request is not held after an uncertain one. */
export function canAct(id: string, actingId: string | undefined, heldIds: readonly string[]): boolean {
    return actingId === undefined && !heldIds.includes(id);
}

/** Apple MyRequestsViewModel.canCancel. */
export function canCancel(record: MediaRequest, actingId: string | undefined, heldIds: readonly string[]): boolean {
    return isCancelable(record) && canAct(record.id, actingId, heldIds);
}

/** Apple MyRequestsViewModel.canRemove. The server flag is RequestsFeatureStore.removeFailedSupported. */
export function canRemove(record: MediaRequest, removeFailedSupported: boolean, actingId: string | undefined, heldIds: readonly string[]): boolean {
    return removeFailedSupported && isRemovable(record) && canAct(record.id, actingId, heldIds);
}

/**
 * The card that slides into a removed card's place, or the last card when the
 * removed one was last. Apple's focus engine lands on that neighbor.
 */
export function neighborKey(keys: readonly string[], removed: string): string | undefined {
    const index = keys.indexOf(removed);
    const rest = keys.filter(key => key !== removed);
    if (rest.length === 0) return undefined;
    if (index < 0) return rest[0];
    return rest[Math.min(index, rest.length - 1)];
}

function browsable(mediaType: string): boolean {
    return mediaType === "movie" || mediaType === "series";
}

/** Where focus rests after a record leaves the hub or My Requests. */
export function focusAfterRemoval(data: RequestsHub | MyRequests, removedId: string): FocusTarget {
    if ("sections" in data) {
        const before = orderRequests(data.mine.items).map(item => item.id);
        const next = neighborKey(before, removedId);
        if (next !== undefined) return { zone: "mine", key: next };
        for (const section of data.sections) {
            const title = section.results.find(item => browsable(item.mediaType));
            if (title !== undefined) return { zone: `row:${section.key}`, key: `${title.mediaType}:${title.tmdbId}` };
        }
        return { zone: "page", key: "requests-page" };
    }
    const next = neighborKey(data.items.map(item => item.id), removedId);
    return next === undefined ? { zone: "actions", key: "refresh" } : { zone: "mine", key: next };
}

/** The one list action Apple's MyRequestsViewModel runs at a time, and the rows a removal must keep out. */
export class RequestActionGate {
    actingId: string | undefined;
    notice: string | undefined;
    listMessage: string | undefined;
    readonly held = new Map<string, number>();
    readonly removed = new Set<string>();
    epoch = 0;
    private token = 0;
    private actingToken = 0;
    private holdSerial = 0;

    heldIds(): readonly string[] {
        return [...this.held.keys()];
    }

    /** Claims the slot and clears the previous action's notice. Undefined when the row may not act. */
    begin(id: string): number | undefined {
        if (!canAct(id, this.actingId, this.heldIds())) return undefined;
        this.token += 1;
        this.actingToken = this.token;
        this.actingId = id;
        this.listMessage = undefined;
        this.notice = undefined;
        return this.token;
    }

    /** Frees the slot only when this claim still holds it. A later claim on the same request stays. */
    release(token: number): void {
        if (this.actingToken === token) this.actingId = undefined;
    }

    /** Holds the row until a list read that started after this call succeeds. */
    hold(id: string): number {
        this.holdSerial += 1;
        this.held.set(id, this.holdSerial);
        return this.holdSerial;
    }

    /** The hold serial at the moment a list read starts. */
    cover(): number {
        return this.holdSerial;
    }

    /** A read that started after these holds now shows their result. A newer hold stays. */
    releaseHolds(through: number): void {
        for (const [id, serial] of this.held) if (serial <= through) this.held.delete(id);
        if (this.held.size === 0 && (this.listMessage === UNCONFIRMED_REMOVE_MESSAGE || this.listMessage === UNCONFIRMED_CANCEL_MESSAGE)) this.listMessage = undefined;
    }

    /** The server says the request is gone. Later list answers leave it out. */
    drop(id: string): void {
        this.removed.add(id);
        this.epoch += 1;
    }

    filter<T extends { readonly id: string }>(items: readonly T[]): T[] {
        return items.filter(item => !this.removed.has(item.id));
    }
}
