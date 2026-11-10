// Apple's ExperimentalFeatures: device-local switches for features still in testing, all off until
// the viewer turns one on in Settings. Tizen has no debug build, so there is no default-on case.

import type { PublicStorage } from "./deviceIdentity.ts";

export type ExperimentalFeature = "watchParty";

/** Apple's ExperimentalFeature.title; the settings row shows only the title. */
export const EXPERIMENTAL_FEATURES: readonly { readonly id: ExperimentalFeature; readonly title: string }[] = [
    { id: "watchParty", title: "Watch Party" },
];

const key = (feature: ExperimentalFeature): string => `silo.experimental.${feature}`;

export class ExperimentalFeatures {
    private readonly storage: PublicStorage | undefined;

    constructor(storage: PublicStorage | undefined) {
        this.storage = storage;
    }

    isEnabled(feature: ExperimentalFeature): boolean {
        try { return this.storage?.getItem(key(feature)) === "true"; } catch { return false; }
    }

    setEnabled(feature: ExperimentalFeature, enabled: boolean): void {
        try { this.storage?.setItem(key(feature), String(enabled)); } catch { /* An unwritable store leaves the feature off. */ }
    }
}
