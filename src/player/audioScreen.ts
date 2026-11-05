import type { Audiobook } from "../contracts/v2/audiobooks.ts";
import type { Clock } from "../api/clock.ts";
import { FocusHost } from "../ui/browseFocus.ts";
import { actionButton, zoneNode } from "../ui/browseViews.ts";
import { artworkUrl, clockTime } from "../ui/browseModel.ts";
import { el } from "../ui/screen.ts";
import type { PlaybackView, PlayerControls } from "./controller.ts";
import type { PlayerScreen } from "./playerScreen.ts";
import { errorText } from "./playerScreen.ts";
import { remoteKey } from "../ui/keys.ts";
import { artwork } from "../ui/browseViews.ts";
import { playbackBar } from "./playbackBar.ts";
import { heroBackdrop } from "../ui/heroBackdrop.ts";
import { cleanAudioTitle } from "../ui/audiobookDetail.ts";

export function mountAudioScreen(root: HTMLElement, controls: PlayerControls, book: Audiobook, clock: Clock, baseUrl = document.baseURI): PlayerScreen {
    const section = el("section", "browse audio-player");
    section.setAttribute("data-screen", "audio-player");
    root.appendChild(section);
    const host = new FocusHost(section);
    const poster = artworkUrl(book.poster, baseUrl);
    const backdrop = poster === undefined ? el("div", "audio-background") : heroBackdrop(poster, undefined, new Map(), true);
    let view: PlaybackView = { phase: "loading", title: book.title };
    let chapters = false;
    let sleepMenu = false;
    let sleep = 0;
    let sleepDue: number | undefined;
    let cancelCountdown: (() => void) | undefined;
    let sleepExpired = false;
    let pausingForSleep = false;
    let cancelSleep: (() => void) | undefined;
    const sleepLabel = (): string => {
        if (sleepDue === undefined) return "Sleep";
        const remaining = Math.max(0, Math.ceil((sleepDue - clock.now()) / 1000));
        return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
    };
    const updateCountdown = (): void => {
        const button = section.querySelector<HTMLElement>('[data-focus="sleep"]');
        if (button !== null) button.textContent = sleepLabel();
        if (sleepDue !== undefined && sleepDue > clock.now()) cancelCountdown = clock.schedule(updateCountdown, 1000);
    };
    const pauseForSleep = (): void => {
        if (pausingForSleep || !sleepExpired || (view.phase !== "playing" && view.phase !== "paused")) return;
        if (view.phase === "paused") { sleepExpired = false; sleep = 0; sleepDue = undefined; cancelCountdown?.(); return; }
        pausingForSleep = true;
        try { controls.setPaused(true); } finally { pausingForSleep = false; }
    };
    const render = (): void => {
        const focus = host.focused();
        const content: HTMLElement[] = [el("p", "audio-eyebrow", "Audiobook"), el("h1", "audio-title", cleanAudioTitle(book.title, book.metadata?.series?.name))];
        const author = book.metadata?.authors.filter(Boolean).join(", ");
        if (author) content.push(el("p", "audio-author", author));
        const stop = actionButton("stop", "Stop", () => controls.back());
        stop.element.setAttribute("aria-label", "Stop Listening");
        const buttons = [stop];
        if (view.phase === "playing" || view.phase === "paused") {
            const intervals = view.seekIntervals;
            const position = view.positionSeconds;
            const chapter = [...book.chapters].reverse().find(chapter => chapter.start <= position);
            if (chapter !== undefined) content.push(el("p", "audio-chapter", chapter.title));
            const duration = view.durationSeconds ?? book.duration;
            const bar = playbackBar("Playback Position");
            bar.classList.add("audio-progress");
            bar.setAttribute("aria-valuemax", String(duration));
            bar.setAttribute("aria-valuenow", String(position));
            bar.addEventListener("keydown", event => {
                const key = remoteKey(event);
                if (key !== "left" && key !== "right") return;
                event.preventDefault(); event.stopPropagation();
                controls.seekBy(key === "left" ? -intervals.backward : intervals.forward);
            });
            const fill = el("div", "player-bar-fill");
            fill.style.width = `${duration > 0 ? Math.min(100, position / duration * 100) : 0}%`;
            bar.append(fill);
            for (const chapter of book.chapters.slice(1)) if (duration > 0) {
                const tick = el("span", "audio-chapter-tick");
                tick.style.left = `${chapter.start / duration * 100}%`; bar.append(tick);
            }
            content.push(bar, el("p", "audio-time", `${clockTime(position)}     -${clockTime(Math.max(0, duration - position))}`));
            const rate = el("span", "audio-rate", "1×");
            rate.setAttribute("aria-label", "Playback Speed");
            content.push(rate);
            buttons.push(actionButton("previous", "Previous Chapter", () => controls.seekToSeconds([...book.chapters].reverse().find(chapter => chapter.start < position - 5)?.start ?? 0)));
            buttons.push(actionButton("rewind", `Back ${intervals.backward} seconds`, () => controls.seekBy(-intervals.backward)),
                actionButton("pause", view.phase === "paused" ? "Play" : "Pause", () => controls.togglePause()),
                actionButton("forward", `Forward ${intervals.forward} seconds`, () => controls.seekBy(intervals.forward)));
            buttons.push(actionButton("next", "Next Chapter", () => { const next = book.chapters.find(chapter => chapter.start > position + 1); if (next !== undefined) controls.seekToSeconds(next.start); }));
            if (book.chapters.length > 0) buttons.push(actionButton("chapters", chapters ? "Close Chapters" : "Chapters", () => { chapters = !chapters; render(); }));
            const timer = actionButton("sleep", sleepLabel(), () => { sleepMenu = !sleepMenu; render(); });
            timer.element.setAttribute("aria-label", "Sleep Timer");
            timer.element.setAttribute("aria-valuetext", sleep === 0 ? "Off" : sleepLabel());
            timer.element.setAttribute("aria-expanded", String(sleepMenu));
            buttons.push(timer);
            if (sleepMenu) for (const minutes of [0, 15, 30, 60]) buttons.push(actionButton(`sleep:${minutes}`, minutes === 0 ? "Off" : `${minutes} min`, () => {
                cancelSleep?.(); sleepExpired = false; sleep = minutes;
                cancelCountdown?.(); sleepDue = minutes > 0 ? clock.now() + minutes * 60000 : undefined;
                updateCountdown();
                sleepMenu = false;
                if (minutes > 0) cancelSleep = clock.schedule(() => { sleepExpired = true; pauseForSleep(); render(); }, minutes * 60000);
                render();
            }));
            if (chapters) {
                const items = book.chapters.length ? book.chapters : book.parts.map((part, index) => ({ title: `Part ${index + 1}`, start: part.offset }));
                for (const [index, chapter] of items.entries()) buttons.push(actionButton(`chapter:${index}`, chapter.title, () => { controls.seekToSeconds(chapter.start); chapters = false; render(); }));
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
        } else content.push(el("p", "browse-text", "Starting audiobook"));
        const transport = buttons.filter(button => ["previous", "rewind", "pause", "forward", "next"].includes(button.key));
        const options = buttons.filter(button => !transport.includes(button) && !button.key.startsWith("sleep:") && !button.key.startsWith("chapter:"));
        const menu = buttons.filter(button => button.key.startsWith("sleep:") || button.key.startsWith("chapter:"));
        content.push(zoneNode("audio-transport", transport), zoneNode("audio-options", options), zoneNode("browse-panel-list audio-menu", menu));
        const identity = el("div", "audio-identity"); identity.append(...content);
        const layout = el("div", "audio-layout");
        layout.append(artwork("audio-cover", book.poster, baseUrl, ""), identity);
        const bar = identity.querySelector<HTMLElement>('[data-focus="position"]');
        host.show({ name: "audio-player", content: [backdrop, layout], zones: [
            { id: "progress", layout: "row", items: bar === null ? [] : [{ key: "position", element: bar }] },
            { id: "transport", layout: "row", items: transport }, { id: "options", layout: "row", items: options },
            { id: "menu", layout: "column", items: menu },
        ], focus: { zone: "transport", key: "pause" }, back: () => { if (sleepMenu || chapters) { sleepMenu = false; chapters = false; render(); } else controls.back(); } }, focus);
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
    return { destroy() { cancelSleep?.(); cancelCountdown?.(); unsubscribe(); document.removeEventListener("visibilitychange", visibility); document.removeEventListener("keydown", mediaKey); host.destroy(); section.remove(); } };
}
