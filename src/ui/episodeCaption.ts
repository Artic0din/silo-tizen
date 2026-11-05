/** Apple EpisodeCardCaption and MediaTextFormatting; calendar dates have no UTC conversion. */
export function episodeAirDate(value: string | undefined): string | undefined {
    const raw = value?.trim();
    if (!raw) return undefined;
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
    if (match === null) {
        if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return raw;
        const instant = new Date(raw);
        return Number.isNaN(instant.getTime()) ? raw : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(instant);
    }
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const date = new Date(0);
    date.setFullYear(year, month - 1, day);
    date.setHours(12, 0, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return raw;
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

export function episodeRuntime(minutes: number): string | undefined {
    if (minutes <= 0) return undefined;
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}
