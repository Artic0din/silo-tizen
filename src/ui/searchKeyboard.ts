// tvOS draws Search's keyboard itself for `.searchable` (silo-apple ViewExtensions.swift:304): one row under the
// field of 123, SPACE, a to z and delete. The Samsung TV's own keyboard covers half the page, so Search draws that row.

import type { FocusItem } from "./browseFocus.ts";
import { claimNumberKeys } from "./keys.ts";
import { el } from "./screen.ts";

const LETTERS = [..."abcdefghijklmnopqrstuvwxyz"];
/** The standard Apple 123 page: digits, then the symbols beneath them. */
const SYMBOLS = [..."1234567890-/:;()$&@\".,?!'"];
/** SF Symbols `delete.left.fill`: a filled key with the cross cut out, so it shows the key colour behind it when focused. */
const DELETE_ICON = '<svg viewBox="0 0 42 32" aria-hidden="true"><mask id="search-delete-cut"><rect width="42" height="32" fill="#fff"/><path d="m21 10 11 12m0-12-11 12" stroke="#000" stroke-width="3.4" stroke-linecap="round"/></mask><path fill="currentColor" mask="url(#search-delete-cut)" d="M13 1h24a5 5 0 0 1 5 5v20a5 5 0 0 1-5 5H13a3 3 0 0 1-2.2-1L.7 17.3a2 2 0 0 1 0-2.6L10.8 2a3 3 0 0 1 2.2-1Z"/></svg>';

export interface SearchKeyboard {
    readonly element: HTMLElement;
    /** The keys on screen, left to right. */
    readonly items: () => readonly FocusItem[];
    readonly destroy: () => void;
}

/** `edit` changes the query; `repaged` runs after 123 or abc swaps the characters. */
export function searchKeyboard(edit: (change: (query: string) => string) => void, repaged: () => void): SearchKeyboard {
    const element = el("div", "search-keyboard");
    element.setAttribute("role", "group");
    element.setAttribute("aria-label", "Keyboard");
    const type = (text: string): void => edit(query => query + text);
    const key = (id: string, className: string, label: string, name: string | undefined, press: () => void): FocusItem => {
        const button = el("button", `search-key ${className}`, label);
        button.type = "button";
        button.setAttribute("data-focus", id);
        if (name !== undefined) button.setAttribute("aria-label", name);
        button.addEventListener("click", press);
        return { key: id, element: button };
    };
    let symbols = false;
    const mode = key("key:mode", "search-key-label search-key-mode", "123", "Numbers and symbols", () => {
        symbols = !symbols;
        mode.element.textContent = symbols ? "abc" : "123";
        mode.element.setAttribute("aria-label", symbols ? "Letters" : "Numbers and symbols");
        place();
        repaged();
    });
    const space = key("key:space", "search-key-label search-key-space", "SPACE", "Space", () => type(" "));
    const remove = key("key:delete", "search-key-delete", "", "Delete", () => edit(query => query.slice(0, -1)));
    remove.element.innerHTML = DELETE_ICON;
    const letters = LETTERS.map(letter => key(`key:${letter}`, "", letter, undefined, () => type(letter)));
    const marks = SYMBOLS.map(mark => key(`key:${mark}`, "", mark, undefined, () => type(mark)));
    let items: readonly FocusItem[] = [];
    // Only the characters change places, so the focused 123 key is never detached and keeps focus.
    const place = (): void => {
        for (const item of symbols ? letters : marks) item.element.remove();
        const shown = symbols ? marks : letters;
        remove.element.before(...shown.map(item => item.element));
        items = [mode, space, ...shown, remove];
    };
    element.append(mode.element, space.element, remove.element);
    place();

    element.addEventListener("keydown", event => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        // tvOS types once per press; Chromium clicks a focused button on every auto-repeated Enter.
        if (event.key === "Enter" && event.repeat) { event.preventDefault(); return; }
        // A hardware keyboard types its characters, Space included, instead of pressing the focused key.
        // The remote's number keys arrive with only a key code.
        const text = event.key.length === 1 ? event.key : event.keyCode >= 48 && event.keyCode <= 57 ? String(event.keyCode - 48) : undefined;
        if (text !== undefined) { event.preventDefault(); type(text); }
        else if (event.key === "Backspace") { event.preventDefault(); edit(query => query.slice(0, -1)); }
    });
    let claimed = false;
    const claim = (on: boolean): void => {
        if (claimed === on) return;
        claimed = on;
        claimNumberKeys(on);
        if (on) document.addEventListener("focusin", released);
        else document.removeEventListener("focusin", released);
    };
    // Focus anywhere else releases them, even when Search left without the key losing focus first.
    const released = (event: FocusEvent): void => { if (!(event.target instanceof Node && element.contains(event.target))) claim(false); };
    element.addEventListener("focusin", () => claim(true));
    return { element, items: () => items, destroy: () => claim(false) };
}
