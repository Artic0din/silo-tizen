import type { RequestSpec } from "../api/http.ts";
import { settingsOperations } from "../api/settingsOperations.ts";
import { decodePrimaryMenu, PRIMARY_MENU_KEY, type PrimaryMenu } from "../contracts/v2/navigation.ts";

type Read = <T>(spec: RequestSpec<T>, signal: AbortSignal) => Promise<T>;

/** Optional navigation preferences belong to the current Browse server/profile owner. */
export class NavigationSettings {
    private controller: AbortController | undefined;
    private menu: PrimaryMenu | null = null;
    private readonly read: Read;
    private readonly changed: () => void;
    constructor(read: Read, changed: () => void) { this.read = read; this.changed = changed; }
    get value(): PrimaryMenu | null { return this.menu; }

    async reload(): Promise<void> {
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        try {
            const capability = await this.read(settingsOperations.settingsCapabilities(), controller.signal);
            if (controller.signal.aborted || !capability.allowed || capability.state !== "available" || capability.manifestRevision < 5 || !capability.supportsBatchedEffective || !capability.clientFamilies.includes("tv")) return;
            const values = await this.read({ ...settingsOperations.effectiveSettings([PRIMARY_MENU_KEY]), clientFamily: "tv" }, controller.signal);
            const menu = decodePrimaryMenu(values.get(PRIMARY_MENU_KEY)?.value);
            if (controller.signal.aborted) return;
            const changed = JSON.stringify(menu) !== JSON.stringify(this.menu);
            this.menu = menu;
            if (changed) this.changed();
        } catch {
            // An unavailable optional preference retains the last confirmed menu, or Apple's default.
        }
    }

    destroy(): void { this.controller?.abort(); }
}
