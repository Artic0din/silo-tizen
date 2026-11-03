import { ApiError } from "../api/errors.ts";
import type { Clock } from "../api/clock.ts";
import { detailOperations } from "../api/detailOperations.ts";
import type { NativeSession } from "../session/session.ts";
import { resumeSeconds, type PlayRequest } from "./browseModel.ts";

const RESUME_LOOKUP_TIMEOUT_MS = 3000;

export async function freshPlayPosition(session: NativeSession, request: PlayRequest, clock: Clock, signal: AbortSignal): Promise<number> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let cancel = (): void => undefined;
    try {
        const timeout = new Promise<never>((_resolve, reject) => {
            cancel = clock.schedule(() => { reject(new ApiError({ kind: "timeout" })); controller.abort(); }, RESUME_LOOKUP_TIMEOUT_MS);
        });
        const fresh = await Promise.race([session.call({ ...detailOperations.resumePosition(request.contentId, request.fileId), profileScoped: true, signal: controller.signal }), timeout]);
        return resumeSeconds(fresh.position, fresh.duration) ?? 0;
    } catch (error) {
        if (!signal.aborted && error instanceof ApiError && (error.failure.kind === "network" || error.failure.kind === "timeout" || error.status === 501 || error.status === 503)) return request.startSeconds ?? 0;
        throw error;
    } finally {
        cancel();
        signal.removeEventListener("abort", abort);
    }
}
