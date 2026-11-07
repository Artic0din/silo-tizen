import type { Clock } from "../api/clock.ts";
import { abortedError } from "../api/http.ts";
import type { SeekThumbnail } from "../contracts/v2/trickplay.ts";
import type { PlayerControls } from "./controller.ts";
import { el } from "../ui/screen.ts";

/** `TVPlayerControls.scrubPreviewCardWidth` and `scrubPreviewBottomInset` at silo-apple 2ef3a171. */
const CARD_WIDTH = 340;
const BOTTOM_INSET = 300;

/**
 * Apple `scrubPreviewLeadingInset`: center the card on the playhead and keep it inside the
 * timeline's horizontal bounds. The inset is the live bar, which is the measured transport
 * inset, so the card follows the puck on this layout.
 */
function placeThumbnail(frame: HTMLElement, parent: HTMLElement, seconds: number, duration: number): void {
    const bar = parent.querySelector(".player-bar");
    if (!(bar instanceof HTMLElement)) return;
    const host = parent.getBoundingClientRect();
    const track = bar.getBoundingClientRect();
    if (host.width <= 0 || track.width <= 0) return;
    const fraction = duration > 0 ? Math.min(Math.max(seconds / duration, 0), 1) : 0;
    const playhead = track.left + track.width * fraction;
    const minimum = track.left;
    const maximum = Math.max(minimum, track.right - CARD_WIDTH);
    const left = Math.min(Math.max(playhead - CARD_WIDTH / 2, minimum), maximum);
    frame.style.left = `${left - host.left}px`;
    frame.style.bottom = `${BOTTOM_INSET}px`;
}

/** One loaded sheet and at most one replacement; image requests carry only signed authorization. */
export function mountSeekThumbnail(parent: HTMLElement, controls: PlayerControls, clock: Clock): { show(seconds: number, duration: number): void; clear(): void } {
    const frame = el("div", "player-thumbnail");
    const crop = el("div", "player-thumbnail-frame");
    const time = el("p", "player-thumbnail-time");
    frame.append(crop, time);
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
        show(seconds, duration) {
            request?.abort();
            const target = new AbortController();
            request = target;
            placeThumbnail(frame, parent, seconds, duration);
            frame.hidden = true;
            time.textContent = previewClock(seconds);
            void controls.seekThumbnail(seconds, target.signal, loadSheet).then((tile) => {
                if (target.signal.aborted || request !== target || tile === undefined || sheet === undefined) return;
                const frameWidth = 320;
                const scale = frameWidth / tile.width;
                crop.style.width = `${frameWidth}px`;
                crop.style.height = `${tile.height * scale}px`;
                sheet.style.width = `${tile.sheetWidth * scale}px`;
                sheet.style.height = `${tile.sheetHeight * scale}px`;
                sheet.style.left = `${-tile.x * scale}px`;
                sheet.style.top = `${-tile.y * scale}px`;
                crop.textContent = "";
                crop.appendChild(sheet);
                frame.hidden = false;
            }, () => { if (request === target) frame.hidden = true; });
        },
        clear() {
            request?.abort();
            request = undefined;
            sheet?.removeAttribute("src");
            sheet = undefined;
            crop.textContent = "";
            time.textContent = "";
            frame.hidden = true;
        },
    };
}

/** `PlayerTimeFormatter.formatHMS`, the same clock as the transport elapsed label. */
function previewClock(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const two = (value: number): string => (value < 10 ? `0${value}` : String(value));
    return hours > 0 ? `${hours}:${two(minutes)}:${two(secs)}` : `${minutes}:${two(secs)}`;
}
