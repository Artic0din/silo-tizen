import { el } from "../ui/screen.ts";
import type { TrackView } from "./controller.ts";
import { currentChapter, type PlayerHUD } from "./playerHUD.ts";
import { delayLabel } from "./subtitleAppearance.ts";
import { paneColumn, settingRow } from "./subtitleMenu.ts";

type Choice = (id: string, label: string, selected: boolean, detail?: string) => HTMLButtonElement;

export function fillHUDPane(list: HTMLElement, name: string, hud: PlayerHUD | undefined, seconds: number, choice: Choice, time: (seconds: number) => string): void {
    if (name === "Stats") {
        list.appendChild(el("h2", "player-menu-heading", "PLAYBACK STATS"));
        for (const [label, value] of hud?.stats ?? [["Engine", "AVPlay"]]) {
            const row = el("p", "player-info-row", `${label}: ${value}`);
            row.tabIndex = -1;
            row.dataset.focus = `stat:${label}`;
            list.appendChild(row);
        }
    } else if (name === "Chapters") {
        list.appendChild(el("h2", "player-menu-heading", "CHAPTERS"));
        const chapters = hud?.chapters ?? [];
        const current = currentChapter(chapters, seconds);
        chapters.forEach((chapter, index) => list.appendChild(choice(`chapter:${index}`, `${String(index + 1).padStart(2, "0")}  ${chapter.title}`, index === current, time(chapter.seconds))));
    }
}

/** VideoPane (TVPlayerInfoHUD.swift:801, columns at 821-920): PLAYBACK and SYNC columns. SYNC holds Subtitle delay and Auto-play next. */
export function fillVideoPane(list: HTMLElement, hud: PlayerHUD | undefined, tracks: TrackView, choice: Choice): void {
    const columns = el("div", "player-menu-columns player-menu-columns-video");
    const playback = paneColumn("PLAYBACK", "player-menu-column-playback");
    const sync = paneColumn("SYNC", "player-menu-column-sync");
    for (const speed of hud?.speeds ?? []) playback.rows.append(choice(`speed:${speed}`, `Speed · ${speed === 1 ? "1.0" : speed.toFixed(2)}×`, hud?.speed === speed));
    for (const aspect of hud?.aspects ?? []) playback.rows.append(choice(`aspect:${aspect}`, `Aspect · ${aspect}`, hud?.aspect === aspect));
    const quality = tracks.quality;
    if (quality !== undefined && quality.choices.length > 1) for (const option of quality.choices) playback.rows.append(choice(`quality:${option.id}`, option.label, option.id === quality.selectedId));
    // The same overlay delay the Subtitles pane's Delay row sets.
    const display = tracks.subtitleTools?.overlay === true ? tracks.subtitleTools.display : undefined;
    if (display?.delay === true) sync.rows.append(settingRow("subtitle-video-delay", "Subtitle delay", delayLabel(display.delayMs)));
    if (hud?.autoNext !== undefined) sync.rows.append(settingRow("auto-next", "Auto-play next", hud.autoNext ? "On" : "Off", { chevron: false, pressed: hud.autoNext }));
    columns.append(playback.column, sync.column);
    list.append(columns);
    if (list.querySelector("[data-focus]") === null) {
        const note = el("p", "player-menu-note", "No video controls available for this stream.");
        note.tabIndex = -1;
        note.dataset.focus = "video-empty";
        playback.rows.append(note);
    }
}
