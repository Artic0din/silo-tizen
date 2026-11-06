// TVGeneralSettingsView.swift:24-33,213-230 and AppleTVUserContext.swift:18-23
// at silo-apple e28300c6. Tizen has no TVUserManager, so this is Apple's branch
// for a context that does not keep a separate pairing, with "Apple TV" removed
// the same way the other Settings copy says "this TV".

const PAIRING_DESCRIPTION = "This TV user context is not set to keep separate app preferences. Silo uses the profile pairing available to the current app context, and you can change it here at any time.";
const ASK_EVERY_TIME = "Ask Every Time is on, so Silo will still show Who's Watching at launch.";

/** Apple's paired-profile value: the active name only when it is the profile this TV reopens. */
export function pairedProfileLabel(rememberedId: string | undefined, activeId: string | undefined, activeName: string): string {
    if (rememberedId === undefined) return "Not paired";
    if (activeId === undefined || rememberedId !== activeId) return "Saved profile";
    return activeName;
}

export function pairedProfileDescription(askEveryTime: boolean): string {
    return askEveryTime ? `${PAIRING_DESCRIPTION} ${ASK_EVERY_TIME}` : PAIRING_DESCRIPTION;
}
