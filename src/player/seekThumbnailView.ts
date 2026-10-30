import type { Clock } from "../api/clock.ts";
import { abortedError } from "../api/http.ts";
import type { SeekThumbnail } from "../contracts/v2/trickplay.ts";
import type { PlayerControls } from "./controller.ts";
import { el } from "../ui/screen.ts";

/** One loaded sheet and at most one replacement; image requests carry only signed authorization. */
export function mountSeekThumbnail(parent: HTMLElement, controls: PlayerControls, clock: Clock): { show(seconds: number): void; clear(): void } {
    const frame = el("div", "player-thumbnail");
    frame.setAttribute("aria-hidden", "true");
    frame.hidden = true;
    parent.appendChild(frame);
    let request: AbortController | undefined;
    let sheet: HTMLImageElement | undefined;

    const loadSheet = (tile: SeekThumbnail, signal: AbortSignal): Promise<void> => {
        if (sheet?.getAttribute("src") === tile.url && sheet.naturalWidth === tile.sheetWidth && sheet.naturalHeight === tile.sheetHeight) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
            const image = new Image();
            image.alt = "";
            image.referrerPolicy = "no-referrer";
            const finish = (error?: Error): void => {
                cancelTimeout();
                image.onload = null;
                image.onerror = null;
                signal.removeEventListener("abort", abort);
                if (error !== undefined) {
                    image.removeAttribute("src");
                    reject(error);
                } else {
                    sheet?.removeAttribute("src");
                    sheet = image;
                    resolve();
                }
            };
            const abort = (): void => finish(abortedError());
            const cancelTimeout = clock.schedule(() => finish(new Error("Seek image timed out")), 15000);
            image.onload = () => finish(image.naturalWidth === tile.sheetWidth && image.naturalHeight === tile.sheetHeight ? undefined : new Error("Seek image geometry mismatch"));
            image.onerror = () => finish(new Error("Seek image unavailable"));
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
            else image.src = tile.url;
        });
    };

    return {
        show(seconds) {
            request?.abort();
            const target = new AbortController();
            request = target;
            frame.hidden = true;
            void controls.seekThumbnail(seconds, target.signal, loadSheet).then((tile) => {
                if (target.signal.aborted || request !== target || tile === undefined || sheet === undefined) return;
                const scale = 320 / tile.width;
                frame.style.width = "320px";
                frame.style.height = `${tile.height * scale}px`;
                sheet.style.width = `${tile.sheetWidth * scale}px`;
                sheet.style.height = `${tile.sheetHeight * scale}px`;
                sheet.style.left = `${-tile.x * scale}px`;
                sheet.style.top = `${-tile.y * scale}px`;
                frame.textContent = "";
                frame.appendChild(sheet);
                frame.hidden = false;
            }, () => { if (request === target) frame.hidden = true; });
        },
        clear() {
            request?.abort();
            request = undefined;
            sheet?.removeAttribute("src");
            sheet = undefined;
            frame.textContent = "";
            frame.hidden = true;
        },
    };
}
