import type { Audiobook } from "../contracts/v2/audiobooks.ts";
import type { Clock } from "../api/clock.ts";
import { FocusHost } from "../ui/browseFocus.ts";
import { actionButton, zoneNode } from "../ui/browseViews.ts";
import { clockTime } from "../ui/browseModel.ts";
import { el } from "../ui/screen.ts";
import type { PlaybackView, PlayerControls } from "./controller.ts";
import type { PlayerScreen } from "./playerScreen.ts";
import { errorText } from "./playerScreen.ts";
import { remoteKey } from "../ui/keys.ts";

export function mountAudioScreen(root: HTMLElement, controls: PlayerControls, book: Audiobook, clock: Clock): PlayerScreen {
    const section = el("section", "browse audio-player");
    section.setAttribute("data-screen", "audio-player");
    root.appendChild(section);
    const host = new FocusHost(section);
    let view: PlaybackView = { phase: "loading", title: book.title };
    let chapters = false;
    let sleep = 0;
    let sleepExpired = false;
    let pausingForSleep = false;
    let cancelSleep: (() => void) | undefined;
    const pauseForSleep = (): void => {
        if (pausingForSleep || !sleepExpired || (view.phase !== "playing" && view.phase !== "paused")) return;
        if (view.phase === "paused") { sleepExpired = false; sleep = 0; return; }
        pausingForSleep = true;
        try { controls.setPaused(true); } finally { pausingForSleep = false; }
    };
    const render = (): void => {
        const focus = host.focused();
        const content: HTMLElement[] = [el("h1", "browse-title", book.title), el("p", "browse-text", "Audiobook · Beta")];
        const buttons = [actionButton("stop", "Stop Listening", () => controls.back())];
        if (view.phase === "playing" || view.phase === "paused") {
            const intervals = view.seekIntervals;
            content.push(el("p", "browse-text", `${clockTime(view.positionSeconds)} / ${clockTime(view.durationSeconds ?? 0)}`));
            buttons.push(actionButton("rewind", `Back ${intervals.backward} seconds`, () => controls.seekBy(-intervals.backward)),
                actionButton("pause", view.phase === "paused" ? "Play" : "Pause", () => controls.togglePause()),
                actionButton("forward", `Forward ${intervals.forward} seconds`, () => controls.seekBy(intervals.forward)),
                actionButton("chapters", chapters ? "Close Chapters" : "Chapters", () => { chapters = !chapters; render(); }));
            for (const minutes of [0, 15, 30, 60]) buttons.push(actionButton(`sleep:${minutes}`, `Sleep: ${minutes === 0 ? "Off" : `${minutes} min`}${sleep === minutes ? " (selected)" : ""}`, () => {
                cancelSleep?.(); sleepExpired = false; sleep = minutes;
                if (minutes > 0) cancelSleep = clock.schedule(() => { sleepExpired = true; pauseForSleep(); render(); }, minutes * 60000);
                render();
            }));
            if (chapters) {
                const items = book.chapters.length ? book.chapters : book.parts.map((part, index) => ({ title: `Part ${index + 1}`, start: part.offset }));
                for (const [index, chapter] of items.entries()) buttons.push(actionButton(`chapter:${index}`, chapter.title, () => controls.seekToSeconds(chapter.start)));
                if (!items.length) content.push(el("p", "browse-text", "No chapters available."));
            }
            for (const notice of view.tracks.notices) content.push(el("p", "browse-error", notice));
            if (view.tracks.change.state === "failed") content.push(el("p", "browse-error", "Could not save progress or change chapters. Check the connection and retry the chapter or stop."));
        } else if (view.phase === "error") {
            content.push(el("p", "browse-error", errorText(view.error)));
            buttons.push(actionButton("retry", "Retry", () => { controls.retrySettings(); controls.retryCompletion(); }));
        } else if (view.phase === "completion") {
            content.push(el("p", "browse-text", view.state === "failed" ? "Could not save progress and stop playback." : "Saving progress"));
            if (view.state === "failed" && view.retryable) buttons.push(actionButton("retry", "Retry", () => controls.retryCompletion()));
        } else content.push(el("p", "browse-text", "Loading"));
        content.push(zoneNode("browse-actions browse-panel-list audio-controls", buttons));
        host.show({ name: "audio-player", content, zones: [{ id: "transport", layout: "column", items: buttons }], focus: { zone: "transport", key: "pause" }, back: () => controls.back() }, focus);
    };
    const unsubscribe = controls.subscribe(next => { view = next; pauseForSleep(); render(); });
    const visibility = (): void => {
        if (document.hidden) controls.suspend();
        else controls.restore();
    };
    document.addEventListener("visibilitychange", visibility);
    const mediaKey = (event: KeyboardEvent): void => {
        const key = remoteKey(event);
        if (!["play_pause", "play", "pause", "stop", "rewind", "fast_forward"].includes(key ?? "")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (key === "stop") controls.back();
        else if (key === "play_pause") controls.togglePause();
        else if (key === "play" || key === "pause") controls.setPaused(key === "pause");
        else if (view.phase === "playing" || view.phase === "paused") controls.seekBy(key === "rewind" ? -view.seekIntervals.backward : view.seekIntervals.forward);
    };
    document.addEventListener("keydown", mediaKey);
    host.listen(); render();
    return { destroy() { cancelSleep?.(); unsubscribe(); document.removeEventListener("visibilitychange", visibility); document.removeEventListener("keydown", mediaKey); host.destroy(); section.remove(); } };
}
