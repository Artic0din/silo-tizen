// Shows one screen at a time in a root element and moves focus for the remote. A screen is one
// focus zone: its controls in remote order, with one control focused when it appears. Focus is
// restored by control key, never by position, and never left on nothing. Controls placed in rows
// move Left/Right within a row and Up/Down between rows.

import { remoteKey } from "./keys.ts";
import { listenSelectRelease } from "./selectRelease.ts";

export interface Control {
    /** Stable identity within a screen, e.g. "connect"; restores focus across re-renders. */
    readonly key: string;
    readonly element: HTMLElement;
    /** Grid placement, set on every control of the screen or on none; rows in remote order. */
    readonly row?: number;
    /** Grid: where the TV keyboard's Done goes from this field, instead of the next row. */
    readonly done?: string;
    /** Grid: entering this control's row lands here, as a SwiftUI `defaultFocus` in a focus section. */
    readonly landing?: boolean;
    /** Grid: horizontal slot, so a row with a gap (the number pad's blank key) still moves straight up and down. */
    readonly column?: number;
}

export interface Screen {
    /** Identifies the screen; re-showing the same name keeps the focused control. */
    readonly name: string;
    readonly content: readonly HTMLElement[];
    /** Remote order. Up/Left move back, Down/Right move on; text fields keep Left/Right. */
    readonly controls: readonly Control[];
    /** Focused when the screen first appears. */
    readonly focus: string;
    /** Undefined: Back is not handled here and reaches the app's own handler. */
    readonly back: (() => void) | undefined;
}

export class ScreenHost {
    private readonly root: HTMLElement;
    private readonly wordmark: () => HTMLElement;
    /** Kept as the root's first child across screens (a backdrop that must not restart). */
    private readonly behind: HTMLElement | undefined;
    private current: Screen | undefined;

    constructor(root: HTMLElement, wordmark: () => HTMLElement = () => el("div", "signin-wordmark", "SILO"), behind?: HTMLElement) {
        this.root = root;
        this.wordmark = wordmark;
        this.behind = behind;
        listenSelectRelease();
        document.addEventListener("keydown", this.onKey);
    }

    get name(): string | undefined {
        return this.current?.name;
    }

    show(screen: Screen, focus?: string): void {
        const changed = this.current?.name !== screen.name;
        const kept = this.current?.name === screen.name ? this.focusedKey() : undefined;
        this.current = screen;
        const section = el("section", "signin-screen");
        if (changed) {
            section.classList.add("signin-screen-enter");
        }
        section.setAttribute("data-screen", screen.name);
        section.appendChild(this.wordmark());
        for (const node of screen.content) {
            section.appendChild(node);
        }
        while (this.root.lastChild !== null && this.root.lastChild !== this.behind) {
            this.root.removeChild(this.root.lastChild);
        }
        if (this.behind !== undefined && this.behind.parentNode !== this.root) {
            this.root.insertBefore(this.behind, this.root.firstChild);
        }
        this.root.appendChild(section);
        this.focus(focus ?? kept ?? screen.focus);
    }

    destroy(): void {
        document.removeEventListener("keydown", this.onKey);
        this.current = undefined;
        while (this.root.firstChild !== null) {
            this.root.removeChild(this.root.firstChild);
        }
    }

    private focusedKey(): string | undefined {
        const active = document.activeElement;
        return this.current?.controls.find((control) => control.element === active)?.key;
    }

    private focus(key: string): void {
        const controls = this.current?.controls ?? [];
        const target = controls.find((control) => control.key === key) ?? controls[0];
        target?.element.focus();
    }

    private readonly onKey = (event: KeyboardEvent): void => {
        const screen = this.current;
        const key = remoteKey(event);
        if (screen === undefined || key === undefined) {
            return;
        }
        if (key === "back") {
            if (screen.back !== undefined) {
                event.preventDefault();
                screen.back();
            }
            return;
        }
        const active = document.activeElement;
        const index = screen.controls.findIndex((control) => control.element === active);
        if (index === -1) {
            // Focus was lost (a pointer click elsewhere): any remote key brings it back.
            event.preventDefault();
            this.focus(screen.focus);
            return;
        }
        const arrow = key === "up" || key === "down" || key === "left" || key === "right";
        const inText = active instanceof HTMLInputElement;
        if (screen.controls.every((control) => control.row !== undefined)) {
            // Enter is left to the browser and selectRelease here too. The TV keyboard's Done moves down a row.
            const done = key === "ime_done" && inText ? screen.controls[index]?.done : undefined;
            const target = done !== undefined
                ? screen.controls.findIndex((control) => control.key === done)
                : arrow || (key === "ime_done" && inText) ? gridTarget(screen.controls, index, key === "ime_done" ? "down" : key) : -1;
            // A field with nothing beside it keeps Left/Right for its caret.
            if (target === -1 || (inText && (key === "left" || key === "right") && target === index)) {
                return;
            }
            event.preventDefault();
            screen.controls[target]?.element.focus();
            return;
        }
        let step = 0;
        if (key === "up" || (key === "left" && !inText)) {
            step = -1;
        } else if (key === "down" || (key === "right" && !inText) || (key === "ime_done" && inText)) {
            step = 1;
        }
        // Enter is left to the browser: selectRelease clicks a button on release, and a field opens the TV keyboard.
        if (step === 0) {
            return;
        }
        event.preventDefault();
        screen.controls[Math.min(screen.controls.length - 1, Math.max(0, index + step))]?.element.focus();
    };
}

/** Field accessories are reached horizontally; vertical moves stay in the field's lane. */
function gridTarget(controls: readonly Control[], index: number, key: "up" | "down" | "left" | "right"): number {
    const rowOf = (at: number): number => controls[at]?.row ?? 0;
    const row = rowOf(index);
    const inRow = (r: number): number[] => controls.flatMap((_, at) => (rowOf(at) === r ? [at] : []));
    const current = inRow(row);
    const column = current.indexOf(index);
    if (key === "left" || key === "right") {
        return current[Math.min(current.length - 1, Math.max(0, column + (key === "left" ? -1 : 1)))] ?? index;
    }
    const rows = [...new Set(controls.map((_, at) => rowOf(at)))].sort((a, b) => a - b);
    const next = rows[rows.indexOf(row) + (key === "up" ? -1 : 1)];
    if (next === undefined) {
        return index;
    }
    const target = inRow(next);
    const here = controls[index]?.column;
    if (here !== undefined && target.every(at => controls[at]?.column !== undefined)) {
        const distance = (at: number): number => Math.abs((controls[at]?.column ?? 0) - here);
        return target.reduce((best, at) => (distance(at) < distance(best) ? at : best));
    }
    const landing = target.find(at => controls[at]?.landing === true);
    const inputAt = target.find(at => controls[at]?.element instanceof HTMLInputElement);
    const verticalColumn = current.some(at => controls[at]?.element instanceof HTMLInputElement) ? 0 : column;
    return landing ?? inputAt ?? target[Math.min(verticalColumn, target.length - 1)] ?? index;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

export function button(key: string, label: string, onPress: () => void): Control {
    const element = el("button", "signin-button", label);
    element.type = "button";
    element.setAttribute("data-focus", key);
    element.addEventListener("click", onPress);
    return { key, element };
}

export interface Note {
    readonly text: string;
    readonly tone: "error" | "info";
    /** Lets a screen rewrite this note's text in place when what it names changes. */
    readonly id?: string;
}

export function noteNodes(notes: readonly Note[]): HTMLElement[] {
    return notes.map((note) => {
        const node = el("p", note.tone === "error" ? "signin-text signin-error" : "signin-text signin-note", note.text);
        node.setAttribute("role", note.tone === "error" ? "alert" : "status");
        return node;
    });
}

export function actions(controls: readonly Control[]): HTMLElement {
    const row = el("div", "signin-actions");
    for (const control of controls) {
        row.appendChild(control.element);
    }
    return row;
}
