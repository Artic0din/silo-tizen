import type { LaunchBehavior } from "../session/profileLaunch.ts";

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

// ProfileLaunchBehavior.tvDescription at silo-apple 2ef3a171 (ProfileLaunchBehavior.swift:51-58).
// Automatic names the current TV user where Apple says "Apple TV user".
export function profileSelectionCaption(behavior: LaunchBehavior): string {
    switch (behavior) {
        case "automatic":
            return "Use the profile selected for the current TV user. A protected profile can reopen without asking for its PIN.";
        case "askEveryLaunch":
            return "Show Who's Watching whenever you return to Silo.";
        case "afterOneHour":
            return "Show Who's Watching when you've been away from Silo for 1 hour.";
        case "afterTwelveHours":
            return "Show Who's Watching when you've been away from Silo for 12 hours.";
        default: {
            const exhaustive: never = behavior;
            return exhaustive;
        }
    }
}
