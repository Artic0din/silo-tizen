import type { NativeSession } from "../session/session.ts";
import { diagnosticsCapabilities } from "../api/diagnosticsOperations.ts";
import { ApiError } from "../api/errors.ts";
import { actionButton } from "./browseViews.ts";
import type { FocusItem } from "./browseFocus.ts";
import { el } from "./screen.ts";
import { diagnosticsDevice } from "../diagnostics/device.ts";

export const TIZEN_DIAGNOSTICS_BLOCKED = "This server does not accept Tizen diagnostics reports (#138). Nothing has been sent.";

export class SettingsDiagnostics {
    private readonly session: NativeSession;
    private readonly changed: () => void;
    private status = "Checking availability…";
    private busy = false;
    private failed = false;
    private notice = TIZEN_DIAGNOSTICS_BLOCKED;
    private readonly controller = new AbortController();

    constructor(session: NativeSession, changed: () => void) { this.session = session; this.changed = changed; }

    async load(): Promise<void> {
        if (this.busy || this.controller.signal.aborted) return;
        this.busy = true;
        this.failed = false;
        this.status = "Checking availability…";
        this.changed();
        try {
            const capability = await this.session.call({ ...diagnosticsCapabilities(), profileScoped: false, signal: this.controller.signal });
            this.status = capability.available ? "Unavailable" : capability.status;
        } catch (error) {
            this.failed = true;
            this.status = error instanceof ApiError && error.status === 404 ? "Unavailable" : "Offline";
        } finally {
            this.busy = false;
            if (!this.controller.signal.aborted) this.changed();
        }
    }

    stop(): void { this.controller.abort(); }

    render(body: HTMLElement): FocusItem[] {
        const rows: FocusItem[] = [];
        const heading = (text: string): void => { body.appendChild(el("h3", "settings-section-header", text)); };
        const info = (title: string, value: string): void => { body.appendChild(el("p", "settings-value", `${title}: ${value}`)); };
        const button = (key: string, title: string, action: () => void): FocusItem => {
            const row = actionButton(key, title, action);
            rows.push(row); body.appendChild(row.element);
            return row;
        };
        heading("FEATURE STATE");
        const status = el("p", "settings-value", `Status: ${this.status}`);
        status.setAttribute("role", "status"); body.appendChild(status);
        info("Destination", "Unavailable");
        heading("CAPTURE");
        const destination = button("diagnostics-destination", "Send Reports To", () => { this.notice = "No report destinations are available for Tizen. Nothing has been sent."; this.changed(); });
        destination.element.setAttribute("aria-disabled", "true");
        const log = this.session.diagnosticLog;
        const debug = button("diagnostics-debug", "Debug Logging", () => { log.debug = !log.debug; this.changed(); });
        debug.element.setAttribute("role", "switch");
        debug.element.setAttribute("aria-checked", String(log.debug));
        debug.element.appendChild(el("span", "settings-row-value", log.debug ? "On" : "Off"));
        const consent = button("diagnostics-consent", "Crash Reports", () => { this.notice = "Crash reports are unavailable until the server accepts Tizen reports."; this.changed(); });
        consent.element.setAttribute("aria-disabled", "true");
        consent.element.appendChild(el("span", "settings-row-value", "Ask"));
        body.appendChild(el("p", "settings-value", "Logs stay in memory on this TV. Nothing is sent automatically."));
        button("diagnostics-capture", log.capturing ? "Stop Diagnostic Capture" : "Start Diagnostic Capture", () => {
            log.capturing = !log.capturing;
            log.append(log.capturing ? "Diagnostic capture started" : "Diagnostic capture stopped");
            if (log.capturing) log.append(JSON.stringify(diagnosticsDevice()));
            this.notice = log.capturing ? "Diagnostic capture is running on this TV. Nothing has been sent." : "Diagnostic capture stopped. Nothing has been sent.";
            this.changed();
        });
        button("diagnostics-delete", "Delete Local Capture", () => { log.clear(); this.notice = "Local capture deleted. Nothing has been sent."; this.changed(); });
        heading("PENDING REPORTS (0)");
        info("Reports", "None");
        heading("MANUAL REPORT");
        // #138: availability does not advertise supported platforms. Never impersonate another client.
        const send = button("diagnostics-send", "Send Diagnostics Now", () => { this.notice = TIZEN_DIAGNOSTICS_BLOCKED; this.changed(); });
        send.element.setAttribute("aria-disabled", "true");
        if (!log.debug) body.appendChild(el("p", "settings-value", "Debug logging is off. This report contains only the last few minutes of basic logs."));
        body.appendChild(el("p", "settings-value", this.notice));
        heading("SENT HISTORY");
        info("Reports", "None");
        if (this.failed) button("diagnostics-retry", "Retry", () => { void this.load(); });
        return rows;
    }
}
