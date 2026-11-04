import type { MediaRequest, RequestTitle } from "../contracts/v2/requests.ts";

export type RequestDisplay = "pending" | "onTheWay" | "inLibrary" | "needsAttention" | "unavailable";
export interface RequestProgress { readonly display: RequestDisplay; readonly short: string; readonly long: string; readonly completed: number; readonly current: number | undefined }

/** Apple RequestProgress: display state wins over the finer download phase. */
export function requestProgress(item: RequestTitle | MediaRequest): RequestProgress | undefined {
    const state = "request" in item ? item.request.state : item.state;
    const status = "request" in item ? item.request.status : item.status;
    const result = (display: RequestDisplay, short: string, long = short, completed = 0, current: number | undefined = undefined): RequestProgress => ({ display, short, long, completed, current });
    if (state === "available") return result("inLibrary", "In library", "In your library", 4);
    if (state === "cancelled") return result("unavailable", "Unavailable");
    if (state === "declined") return result("needsAttention", "Declined", "Declined", 1, 1);
    if (state === "failed") return result("needsAttention", "Failed", "Request failed", 2, 2);
    if (state === "pending") return result("pending", "Pending", "Waiting for approval", 1, 1);
    if (state === "partially_available") return result("onTheWay", "Partly in library", "Partly in your library", 3, 3);
    const inFlight = (): RequestProgress => {
        if (status === "completed") return result("onTheWay", "Adding to library", "Adding to your library", 3, 3);
        if (status === "downloading") return result("onTheWay", "Downloading", "Downloading", 2, 2);
        if (status === "approved" || status === "queued") return result("onTheWay", "Queued", "Queued for download", 2, 2);
        return result("onTheWay", "On the way", "On the way", 2, 2);
    };
    if (state === "approved" || state === "processing") return inFlight();
    if ("availability" in item && item.availability === "available") return result("inLibrary", "In library", "In your library", 4);
    if (!("request" in item)) {
        if (item.outcome === "declined") return result("needsAttention", "Declined", "Declined", 1, 1);
        if (item.outcome === "failed") return result("needsAttention", "Failed", "Request failed", 2, 2);
        if (item.outcome === "cancelled") return result("unavailable", "Unavailable");
    }
    if (status !== undefined) {
        if (status === "pending") return result("pending", "Pending", "Waiting for approval", 1, 1);
        if (status === "completed") return result("inLibrary", "In library", "In your library", 4);
        if (status === "failed") return result("needsAttention", "Failed", "Request failed", 2, 2);
        return inFlight();
    }
    return "request" in item && item.request.requestable ? undefined : result("unavailable", "Unavailable");
}

export function orderRequests(records: readonly MediaRequest[]): MediaRequest[] {
    return records.flatMap(record => {
        const display = requestProgress(record)?.display;
        if (display === undefined || display === "unavailable") return [];
        const bucket = display === "inLibrary" ? 2 : display === "needsAttention" ? 1 : 0;
        return [{ record, bucket }];
    }).sort((left, right) => left.bucket - right.bucket || (right.record.createdAt ?? 0) - (left.record.createdAt ?? 0)).map(item => item.record);
}
