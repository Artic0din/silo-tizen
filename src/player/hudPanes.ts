import { el } from "../ui/screen.ts";
import type { TrackView } from "./controller.ts";
import { currentChapter, type PlayerHUD } from "./playerHUD.ts";
import { delayLabel } from "./subtitleAppearance.ts";
import { paneColumn, settingRow, type SubtitlePane } from "./subtitleMenu.ts";

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

/** "1.0×", "2.00×": VideoPane.speedLabel (TVPlayerInfoHUD.swift:973). */
function speedLabel(speed: number): string {
    return `${speed === 1 ? "1.0" : speed.toFixed(2)}×`;
}

/** The selected quality's label, or "Switching..." while a switch runs (VideoPane.qualityValue, TVPlayerInfoHUD.swift:938; Switching... is `player.hud.qualitySwitching`). */
function qualityValue(tracks: TrackView): string {
    if (tracks.change.state === "changing" && tracks.change.kind === "quality") return "Switching...";
    const quality = tracks.quality;
    return quality?.choices.find(option => option.id === quality.selectedId)?.label ?? "";
}

/** The PLAYBACK row pickers: Quality, Playback Speed and Aspect, in that order (TVPlayerInfoHUD.swift:825-879). */
export function videoPickerFor(hud: PlayerHUD | undefined, tracks: TrackView, field: string): Omit<Extract<SubtitlePane, { kind: "picker" }>, "origin"> | undefined {
    const quality = tracks.quality;
    if (field === "quality" && quality !== undefined && quality.choices.length > 1) return { kind: "picker", title: "Quality", field, selected: quality.selectedId ?? "", options: quality.choices.map(option => ({ id: option.id, label: option.label })) };
    if (field === "speed" && hud !== undefined && hud.speeds.length > 0) return { kind: "picker", title: "Playback Speed", field, selected: hud.speed === undefined ? "" : String(hud.speed), options: hud.speeds.map(speed => ({ id: String(speed), label: speedLabel(speed) })) };
    if (field === "aspect" && hud !== undefined && hud.aspects.length > 0) return { kind: "picker", title: "Aspect", field, selected: hud.aspect ?? "", options: hud.aspects.map(aspect => ({ id: aspect, label: aspect })) };
    return undefined;
}

/**
 * VideoPane (TVPlayerInfoHUD.swift:801, columns at 821-920): PLAYBACK has Quality, Speed and Aspect rows that open
 * pickers; SYNC has Subtitle delay and Auto-play next.
 */
export function fillVideoPane(list: HTMLElement, hud: PlayerHUD | undefined, tracks: TrackView): void {
    const columns = el("div", "player-menu-columns player-menu-columns-video");
    const playback = paneColumn("PLAYBACK", "player-menu-column-playback");
    const sync = paneColumn("SYNC", "player-menu-column-sync");
    if ((tracks.quality?.choices.length ?? 0) > 1) playback.rows.append(settingRow("video-quality", "Quality", qualityValue(tracks)));
    if ((hud?.speeds.length ?? 0) > 0) playback.rows.append(settingRow("video-speed", "Speed", hud?.speed === undefined ? "" : speedLabel(hud.speed)));
    if ((hud?.aspects.length ?? 0) > 0) playback.rows.append(settingRow("video-aspect", "Aspect", hud?.aspect ?? ""));
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
