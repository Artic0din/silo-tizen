export const INTRO_SKIP_KEY = "playback.intro_skip_mode";
export const CREDITS_SKIP_KEY = "playback.auto_skip_credits";
/** Lower quality when buffering: never, ask or always. Settings revision 23. */
export const BUFFERING_MODE_KEY = "playback.buffering_quality_mode";
export const ADVISORY_KEY = "catalog.show_advisory_age";
export const METADATA_KEY = "catalog.metadata_language";
export const APPEARANCE_KEY = "playback.subtitle_appearance";
export const ROW_KEYS = [INTRO_SKIP_KEY, CREDITS_SKIP_KEY, BUFFERING_MODE_KEY, ADVISORY_KEY, METADATA_KEY, APPEARANCE_KEY, "ui.card_presentation"] as const;
