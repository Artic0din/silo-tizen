import { watchChapters } from "../api/chapterOperations.ts";
import { operations } from "../api/operations.ts";
import type { ItemDetail } from "../contracts/v2/catalog.ts";
import type { NativeSession } from "../session/session.ts";
import type { PlaybackPlan } from "../contracts/v2/playback.ts";
import type { AVPlay } from "./avplay.ts";
import { DISPLAY_MODES, videoOptions, type PlayerAspect } from "./playerHUD.ts";
import type { PlayerChapter } from "../contracts/v2/chapters.ts";

export class HUDState {
    chapters: readonly PlayerChapter[] = [];
    chapterState: "loading" | "ready" | "failed" = "loading";
    speed: number | undefined = 1;
    aspect: PlayerAspect | undefined = "Fit";
    message = "";
    autoBusy = false;
    metadata: ItemDetail | undefined;
    metadataFailed = false;
    private contentId: string | undefined;
    private fileId: string | undefined;
    private generation = 0;

    read(session: NativeSession, contentId: string, fileId: string, signal: AbortSignal, changed: () => void, retry = false): void {
        if (this.contentId !== contentId || retry && this.metadataFailed) {
            this.contentId = contentId;
            this.metadataFailed = false;
            void session.call({ ...operations.getCatalogItem(contentId), signal, profileScoped: true }).then(detail => {
                if (signal.aborted || this.contentId !== contentId) return;
                this.metadata = detail;
                changed();
            }, () => {
                if (signal.aborted) return;
                this.metadataFailed = true;
                changed();
            });
        }
        if (!retry && this.fileId === fileId) return;
        this.fileId = fileId;
        const generation = ++this.generation;
        this.chapters = [];
        this.chapterState = "loading";
        void session.call({ ...watchChapters(contentId, fileId), signal, profileScoped: true }).then(chapters => {
            if (signal.aborted || generation !== this.generation) return;
            this.chapters = chapters;
            this.chapterState = "ready";
            changed();
        }, () => {
            if (signal.aborted || generation !== this.generation) return;
            this.chapterState = "failed";
            changed();
        });
    }

    setVideo(avplay: AVPlay, plan: PlaybackPlan, kind: "speed" | "aspect", value: string): void {
        const options = videoOptions(avplay.setSpeed !== undefined, avplay.setDisplayMethod !== undefined, plan.streamProtocol);
        try {
            if (kind === "speed" && options.speeds.includes(Number(value))) {
                avplay.setSpeed!(Number(value));
                this.speed = Number(value);
            } else if (kind === "aspect" && options.aspects.includes(value as PlayerAspect)) {
                avplay.setDisplayMethod!(DISPLAY_MODES[value as PlayerAspect]);
                this.aspect = value as PlayerAspect;
            } else return;
            this.message = "";
        } catch { this.message = "This video setting is unavailable for this stream. Try another option."; }
    }

    restore(avplay: AVPlay, plan: PlaybackPlan): void {
        const speed = this.speed !== undefined && videoOptions(true, false, plan.streamProtocol).speeds.includes(this.speed) ? this.speed : 1;
        try {
            avplay.setSpeed?.(speed);
            this.speed = speed;
        } catch {
            this.speed = undefined;
            this.message = "Could not restore video settings. Select them again.";
        }
        const aspect = this.aspect ?? "Fit";
        try {
            avplay.setDisplayMethod?.(DISPLAY_MODES[aspect]);
            this.aspect = aspect;
        } catch {
            this.aspect = undefined;
            this.message = "Could not restore video settings. Select them again.";
        }
    }
}
