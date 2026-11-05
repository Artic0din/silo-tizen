import { audioPreferenceOperations, type AudioPreferencePick } from "../api/audioPreferenceOperations.ts";
import { PreplayTrackPreference } from "./preplayTrackPreference.ts";
import type { NativeSession } from "../session/session.ts";

export class PreplayAudioPreference extends PreplayTrackPreference<AudioPreferencePick, { ordinal: number; signature: unknown }> {
    constructor(session: NativeSession, key: string, changed: () => void, refresh: (signal: AbortSignal) => Promise<void>) {
        super(audioPreferenceOperations, session, key, changed, refresh);
    }
}
