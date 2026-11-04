// The subset of Samsung AVPlay (webapis.avplay) the player uses, as the AVPlay API reference
// documents it. States: NONE -> open -> IDLE -> prepareAsync -> READY -> play -> PLAYING <-> PAUSED;
// stop() returns to IDLE and close() to NONE from any state. prepareAsync and seekTo callbacks
// cannot be cancelled, and while a seekTo is pending no other call is allowed. AVPlay cannot set
// request headers (only COOKIE and USER_AGENT streaming properties), so media authentication
// travels in the URL. Times are milliseconds.

export interface AVPlayAsyncError {
    /** WebAPIException name, e.g. NotSupportedError, InvalidAccessError, InvalidStateError. */
    readonly name: string;
}

export interface AVPlayListener {
    onbufferingstart(): void;
    onbufferingprogress(percent: number): void;
    onbufferingcomplete(): void;
    oncurrentplaytime(milliseconds: number): void;
    /** Natural end of the stream. */
    onstreamcompleted(): void;
    onevent(eventType: string, eventData: string): void;
    /** AVPlayError name, e.g. PLAYER_ERROR_CONNECTION_FAILED. */
    onerror(eventType: string): void;
}

/** `AVPlayStreamType` from the AVPlay API reference. */
export type AVPlayTrackType = "VIDEO" | "AUDIO" | "TEXT";

/**
 * One `AVPlayStreamInfo` row from `getTotalTrackInfo` / `getCurrentStreamInfo`.
 * `extra_info` is the documented JSON string. Subtitle rows use
 * `track_num`, `track_lang`, `subtitle_type` and `fourCC`.
 */
export interface AVPlayTrackInfo {
    readonly index: number;
    readonly type: AVPlayTrackType;
    readonly extra_info: string;
}

export interface AVPlay {
    open(url: string): void;
    close(): void;
    prepareAsync(success: () => void, error: (error: AVPlayAsyncError) => void): void;
    setDisplayRect(x: number, y: number, width: number, height: number): void;
    setListener(listener: AVPlayListener): void;
    play(): void;
    pause(): void;
    seekTo(milliseconds: number, success: () => void, error: (error: AVPlayAsyncError) => void): void;
    /**
     * App hide. Valid in READY, PLAYING and PAUSED (AVPlay API). Not pause/play:
     * Samsung's multitasking FAQ says those are the wrong calls for visibility.
     */
    suspend?(): void;
    /**
     * App show. Valid in NONE, PLAYING and PAUSED, not READY. Preferred over the
     * blocking `restore`. `prepare` false lets the platform resume without `prepare()`,
     * which would block the thread and hold a black picture.
     */
    restoreAsync?(url: string | null, resumeTime: number | null, prepare: boolean, success: () => void, error: (error: AVPlayAsyncError) => void): void;
    stop(): void;
    getState(): string;
    getCurrentTime(): number;
    /**
     * TEXT and AUDIO rows of the open stream. Valid in PLAYING and PAUSED.
     * READY is documented only for the synchronous `prepare`, which this client does not use.
     */
    getTotalTrackInfo?(): readonly AVPlayTrackInfo[];
    /**
     * Switch an AUDIO or TEXT track of the open stream. TEXT is valid in PLAYING and PAUSED.
     * The index is `AVPlayStreamInfo.index`, not a server or FFmpeg stream index.
     */
    setSelectTrack?(trackType: "AUDIO" | "TEXT", trackIndex: number): void;
    /**
     * `true` hides subtitles. Samsung titles this as external subtitles; the parameter
     * text says subtitles are hidden. Whether it hides a TEXT track chosen with
     * `setSelectTrack` is not stated.
     */
    setSilentSubtitle?(hidden: boolean): void;
}

function isAVPlay(value: unknown): value is AVPlay {
    return (
        typeof value === "object" &&
        value !== null &&
        "open" in value &&
        typeof value.open === "function" &&
        "close" in value &&
        typeof value.close === "function" &&
        "prepareAsync" in value &&
        typeof value.prepareAsync === "function" &&
        "setListener" in value &&
        typeof value.setListener === "function" &&
        "seekTo" in value &&
        typeof value.seekTo === "function"
    );
}

/** `webapis.avplay` when the page loaded `$WEBAPIS/webapis/webapis.js` on a TV. */
export function findAVPlay(scope: unknown = globalThis): AVPlay | undefined {
    if (typeof scope !== "object" || scope === null || !("webapis" in scope)) {
        return undefined;
    }
    const webapis: unknown = scope.webapis;
    if (typeof webapis !== "object" || webapis === null || !("avplay" in webapis)) {
        return undefined;
    }
    const avplay: unknown = webapis.avplay;
    return isAVPlay(avplay) ? avplay : undefined;
}
