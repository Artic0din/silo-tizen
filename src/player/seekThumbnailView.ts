import type { Clock } from "../api/clock.ts";
import { abortedError } from "../api/http.ts";
import type { SeekThumbnail } from "../contracts/v2/trickplay.ts";
import type { PlayerControls } from "./controller.ts";
import { el } from "../ui/screen.ts";

/** `TVPlayerControls.scrubPreviewCardWidth` at silo-apple 2ef3a171. */
const CARD_WIDTH = 340;
/** SwiftUI line height of SF Pro Rounded Semibold 24, the preview clock. The still is the 180pt frame in `scrubPreviewCard`. */
const PREVIEW_TEXT_LINE = 28.265625;
const PREVIEW_FRAME_HEIGHT = 180;
/** SwiftUI line height of SF Pro Rounded Semibold 28, the transport clock under the scrubber. */
const TIME_ROW_LINE = 32.9765625;
/**
 * `scrubPreviewBottomInset` is 300 from the bottom of `TVPlayerControls`, and the handle
 * is the centre of the 56pt track. Under it: spacing 12, the clock, spacing 12, the 66pt
 * transport, and the stack's 48pt bottom padding. The card bottom is the difference above
 * the handle. The safe area shifts both, so it is not part of this gap.
 */
const HANDLE_CENTER_FROM_CONTROLS_BOTTOM = 48 + 66 + 12 + TIME_ROW_LINE + 12 + 56 / 2;
const ABOVE_HANDLE = 300 - HANDLE_CENTER_FROM_CONTROLS_BOTTOM;

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
    const handleCenter = track.top + track.height / 2;
    frame.style.left = `${left - host.left}px`;
    frame.style.bottom = `${host.bottom - (handleCenter - ABOVE_HANDLE)}px`;
}

/** One loaded sheet and at most one replacement; image requests carry only signed authorization. */
export function mountSeekThumbnail(parent: HTMLElement, controls: PlayerControls, clock: Clock): { show(seconds: number, duration: number): void; clear(): void } {
    const frame = el("div", "player-thumbnail");
    const crop = el("div", "player-thumbnail-frame");
    const time = el("p", "player-thumbnail-time");
    time.style.lineHeight = `${PREVIEW_TEXT_LINE}px`;
    crop.style.height = `${PREVIEW_FRAME_HEIGHT}px`;
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
                crop.style.height = `${PREVIEW_FRAME_HEIGHT}px`;
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
