import { el } from "../ui/screen.ts";
import { currentChapter, type PlayerHUD } from "./playerHUD.ts";

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
    } else if (name === "Video") {
        list.appendChild(el("h2", "player-menu-heading", "PLAYBACK"));
        for (const speed of hud?.speeds ?? []) list.appendChild(choice(`speed:${speed}`, `Speed · ${speed === 1 ? "1.0" : speed.toFixed(2)}×`, hud?.speed === speed));
        for (const aspect of hud?.aspects ?? []) list.appendChild(choice(`aspect:${aspect}`, `Aspect · ${aspect}`, hud?.aspect === aspect));
        if (hud?.autoNext !== undefined) list.appendChild(choice("auto-next", `Auto-play next · ${hud.autoNext ? "On" : "Off"}`, hud.autoNext));
        if (list.querySelector("[data-focus]") === null) {
            const note = el("p", "player-menu-note", "No video controls available for this stream.");
            note.tabIndex = -1;
            note.dataset.focus = "video-empty";
            list.appendChild(note);
        }
    }
}
