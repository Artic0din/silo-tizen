// tvOS draws Search's keyboard itself for `.searchable` (silo-apple ViewExtensions.swift:304): one row under the
// field of 123, SPACE, a to z and delete. The Samsung TV's own keyboard covers half the page, so Search draws that row.

import type { FocusItem, FocusTarget } from "./browseFocus.ts";
import { claimNumberKeys } from "./keys.ts";
import { el } from "./screen.ts";

const LETTERS = [..."abcdefghijklmnopqrstuvwxyz"];
/** The standard Apple 123 page: digits, then the symbols beneath them. */
const SYMBOLS = [..."1234567890-/:;()$&@\".,?!'"];
/** SF Symbols `delete.left.fill`: a filled key with the cross cut out, so it shows the key colour behind it when focused. */
const DELETE_ICON = '<svg viewBox="0 0 42 32" aria-hidden="true"><mask id="search-delete-cut"><rect width="42" height="32" fill="#fff"/><path d="m21 10 11 12m0-12-11 12" stroke="#000" stroke-width="3.4" stroke-linecap="round"/></mask><path fill="currentColor" mask="url(#search-delete-cut)" d="M13 1h24a5 5 0 0 1 5 5v20a5 5 0 0 1-5 5H13a3 3 0 0 1-2.2-1L.7 17.3a2 2 0 0 1 0-2.6L10.8 2a3 3 0 0 1 2.2-1Z"/></svg>';
/** SF Symbols `globe`, the tvOS keyboard's switch to another keyboard. */
const GLOBE_ICON = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="16" cy="16" r="13"/><ellipse cx="16" cy="16" rx="6" ry="13"/><path d="M3 16h26M5.5 9h21M5.5 23h21"/></svg>';
/** The TV keyboard's Done and Cancel keys (Samsung Keyboard/IME guide); Back on its panel arrives as Cancel. */
const IME_DONE = 65376;
const IME_CANCEL = 65385;
const REMOTE_BACK = 10009;
/** What Chromium reports for a key press an input method is processing. */
const IME_PROCESSING = 229;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The query without its last character as a reader sees it, never half of a surrogate pair or accent sequence. */
function withoutLast(query: string): string {
    let last = 0;
    for (const { index } of graphemes.segment(query)) last = index;
    return query.slice(0, last);
}

export interface SearchKeyboard {
    readonly element: HTMLElement;
    /** The keys on screen, left to right. */
    readonly items: () => readonly FocusItem[];
    /** The query field while it takes text from the TV keyboard; otherwise it is not a focus stop. */
    readonly field: () => FocusItem | undefined;
    /** A new Search starts on the letter page with nothing being typed in the TV keyboard. */
    readonly reset: () => void;
    readonly destroy: () => void;
}

/**
 * `input` shows the query and every edit is dispatched to it as an `input` event. `repaint` draws Search again,
 * focusing `focus` when given and otherwise keeping the current focus.
 */
export function searchKeyboard(input: HTMLInputElement, repaint: (focus?: FocusTarget) => void): SearchKeyboard {
    const element = el("div", "search-keyboard");
    element.setAttribute("role", "group");
    element.setAttribute("aria-label", "Keyboard");
    input.readOnly = true;
    input.tabIndex = -1;
    input.setAttribute("data-focus", "query");
    const field: FocusItem = { key: "query", element: input };
    const edit = (change: (query: string) => string): void => {
        input.value = change(input.value);
        input.dispatchEvent(new Event("input"));
    };
    const type = (text: string): void => edit(query => query + text);
    const key = (id: string, className: string, label: string, name: string | undefined, press: () => void): FocusItem => {
        const button = el("button", `search-key ${className}`, label);
        button.type = "button";
        button.setAttribute("data-focus", id);
        if (name !== undefined) button.setAttribute("aria-label", name);
        button.addEventListener("click", press);
        return { key: id, element: button };
    };

    // tvOS reaches other scripts through its keyboard switch. Here that hands the field to the TV keyboard, which
    // types any language the TV has, and a hardware keyboard composes into it; Done, Back or Cancel return to the row.
    let editing: string | undefined;
    /** The view still lists the field after it stopped taking text; the next key focus redraws without it. */
    let stale = false;
    const startEditing = (from: string): void => {
        if (editing !== undefined) return;
        editing = from;
        input.readOnly = false;
        repaint({ zone: "field", key: field.key });
    };
    const stopEditing = (refocus: boolean): void => {
        const from = editing;
        if (from === undefined) return;
        editing = undefined;
        // An uneditable field hides the TV keyboard (Samsung Keyboard/IME guide, "IME Hide Scene").
        input.readOnly = true;
        if (refocus) repaint({ zone: "keyboard", key: from });
        else stale = true;
    };
    input.addEventListener("keydown", event => {
        if (editing === undefined) return;
        const done = event.keyCode === IME_DONE || (event.key === "Enter" && !event.isComposing);
        const cancel = event.keyCode === IME_CANCEL || event.keyCode === REMOTE_BACK || event.key === "Escape";
        if (!done && !cancel) return;
        // Only these leave; preventing any other key would stop the field inserting text.
        event.preventDefault();
        event.stopPropagation();
        stopEditing(true);
    });
    input.addEventListener("blur", () => stopEditing(false));

    let symbols = false;
    const mode = key("key:mode", "search-key-label search-key-mode", "123", "Numbers and symbols", () => {
        symbols = !symbols;
        place();
        repaint();
    });
    const space = key("key:space", "search-key-label search-key-space", "SPACE", "Space", () => type(" "));
    const language = key("key:language", "search-key-language", "", "Other languages", () => startEditing("key:language"));
    language.element.innerHTML = GLOBE_ICON;
    const remove = key("key:delete", "search-key-delete", "", "Delete", () => edit(withoutLast));
    remove.element.innerHTML = DELETE_ICON;
    const letters = LETTERS.map(letter => key(`key:${letter}`, "", letter, undefined, () => type(letter)));
    const marks = [...SYMBOLS.map(mark => key(`key:${mark}`, "", mark, undefined, () => type(mark))), language];
    let items: readonly FocusItem[] = [];
    // Only the characters change places, so the focused 123 key is never detached and keeps focus.
    const place = (): void => {
        mode.element.textContent = symbols ? "abc" : "123";
        mode.element.setAttribute("aria-label", symbols ? "Letters" : "Numbers and symbols");
        for (const item of symbols ? letters : marks) item.element.remove();
        const shown = symbols ? marks : letters;
        remove.element.before(...shown.map(item => item.element));
        items = [mode, space, ...shown, remove];
    };
    element.append(mode.element, space.element, remove.element);
    place();

    element.addEventListener("keydown", event => {
        // A hardware keyboard's input method needs an editable field to compose into.
        if (event.isComposing || event.keyCode === IME_PROCESSING) {
            const focused = items.find(item => item.element === document.activeElement);
            if (focused !== undefined) startEditing(focused.key);
            return;
        }
        // AltGr types characters such as Polish ł; Ctrl, Alt and Meta otherwise make shortcuts.
        if (!event.getModifierState("AltGraph") && (event.ctrlKey || event.metaKey || event.altKey)) return;
        // tvOS types once per press; Chromium clicks a focused button on every auto-repeated Enter.
        if (event.key === "Enter" && event.repeat) { event.preventDefault(); return; }
        // A hardware keyboard types its characters, Space included, instead of pressing the focused key.
        // The remote's number keys arrive with only a key code.
        const text = event.key.length === 1 ? event.key : event.keyCode >= 48 && event.keyCode <= 57 ? String(event.keyCode - 48) : undefined;
        if (text !== undefined) { event.preventDefault(); type(text); }
        else if (event.key === "Backspace") { event.preventDefault(); edit(withoutLast); }
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
    element.addEventListener("focusin", () => {
        claim(true);
        if (stale) { stale = false; repaint(); }
    });
    return {
        element,
        items: () => items,
        field: () => editing === undefined ? undefined : field,
        reset: () => {
            stopEditing(false);
            stale = false;
            symbols = false;
            place();
        },
        destroy: () => { stopEditing(false); claim(false); },
    };
}
