import { actionButton, zoneNode } from "./browseViews.ts";
import type { FocusItem } from "./browseFocus.ts";
import { remoteKey } from "./keys.ts";
import { el } from "./screen.ts";

export interface RequestRecordMenuOptions {
    readonly container: HTMLElement;
    readonly title: string;
    /** Apple's context-menu Cancel Request. Omitted when canCancel is false. */
    readonly cancel?: () => void;
    /** Apple's context-menu Remove Request. Omitted when canRemove is false. */
    readonly remove?: () => void;
    /** Menu or confirmation dismissed without a write. Focus returns to the card. */
    readonly onClose: () => void;
}

/** Apple's tvOS context menu and the remove confirmation on a request card. */
export class RequestRecordMenu {
    private panel: HTMLElement | undefined;
    private items: FocusItem[] = [];
    private pressed = false;
    private options: RequestRecordMenuOptions | undefined;
    private readonly onKey = (event: KeyboardEvent): void => {
        if (!this.active) return;
        const key = remoteKey(event);
        if (key === undefined && event.key !== "Tab") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        // Any other key ends a held Select, so its release cannot choose a button it did not press.
        if (key !== "enter") this.pressed = false;
        if (key === "back") this.close();
        else if (key === "up" || key === "down" || key === "left" || key === "right" || event.key === "Tab") {
            const index = this.items.findIndex(item => item.element === document.activeElement);
            const step = key === "up" || key === "left" || event.shiftKey ? -1 : 1;
            this.items[Math.max(0, Math.min(this.items.length - 1, index + step))]?.element.focus({ preventScroll: true });
        } else if (key === "enter") {
            // tvOS chooses on Select's release; repeats belong to the press already down.
            if (!event.repeat) this.pressed = true;
        }
    };
    private readonly onRelease = (event: KeyboardEvent): void => {
        if (remoteKey(event) !== "enter") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!this.pressed) return;
        this.pressed = false;
        this.items.find(item => item.element === document.activeElement)?.element.click();
    };

    get active(): boolean { return this.panel !== undefined; }

    open(options: RequestRecordMenuOptions): void {
        if (this.active) return;
        this.options = options;
        this.pressed = false;
        this.panel = el("div", "card-actions-scrim");
        options.container.appendChild(this.panel);
        document.addEventListener("keydown", this.onKey, true);
        document.addEventListener("keyup", this.onRelease, true);
        this.showActions();
    }

    close(): void {
        const options = this.options;
        this.dismiss();
        options?.onClose();
    }

    destroy(): void {
        this.dismiss();
    }

    private showActions(): void {
        const options = this.options;
        if (options === undefined) return;
        const items: FocusItem[] = [];
        if (options.cancel !== undefined) items.push(actionButton("cancel-request", "Cancel Request", () => this.choose(options.cancel)));
        if (options.remove !== undefined) items.push(actionButton("remove-request", "Remove Request", () => this.showConfirmation()));
        this.present(options.title, undefined, items, items[0]?.key);
    }

    /** Apple requestRemoveConfirmation: the title is named, and Keep request is the cancel role. */
    private showConfirmation(): void {
        const options = this.options;
        if (options === undefined) return;
        const remove = actionButton("confirm-remove", "Remove request", () => this.choose(options.remove));
        const keep = actionButton("keep-request", "Keep request", () => this.close());
        this.present("Remove this request?", `Your failed request for \u201C${options.title}\u201D will be deleted. You can request the title again later.`, [remove, keep], "keep-request");
    }

    private choose(action: (() => void) | undefined): void {
        this.dismiss();
        action?.();
    }

    private present(title: string, message: string | undefined, items: FocusItem[], focus: string | undefined): void {
        const panel = this.panel;
        if (panel === undefined) return;
        this.items = items;
        const content = el("div", "card-actions-panel");
        content.setAttribute("role", "alertdialog");
        content.setAttribute("aria-modal", "true");
        const heading = el("h1", "browse-section-title", title);
        heading.id = "request-record-menu-title";
        content.setAttribute("aria-labelledby", heading.id);
        content.appendChild(heading);
        if (message !== undefined) {
            const copy = el("p", "browse-text", message);
            copy.id = "request-record-menu-copy";
            content.setAttribute("aria-describedby", copy.id);
            content.appendChild(copy);
        }
        content.appendChild(zoneNode("card-actions-buttons", items));
        while (panel.firstChild !== null) panel.removeChild(panel.firstChild);
        panel.appendChild(content);
        (items.find(item => item.key === focus) ?? items[0])?.element.focus({ preventScroll: true });
    }

    private dismiss(): void {
        this.panel?.remove();
        this.panel = undefined;
        this.items = [];
        this.pressed = false;
        this.options = undefined;
        document.removeEventListener("keydown", this.onKey, true);
        document.removeEventListener("keyup", this.onRelease, true);
    }
}
