const CAPACITY = 4000;
const LINE_LIMIT = 2048;

/** Last-mile redaction before retention; transport logs never include raw payloads. */
export function redactDiagnostics(value: string, sensitiveValues: readonly string[] = []): string {
    let text = value;
    for (const secret of [...sensitiveValues].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[redacted]");
    return text
        .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, "[redacted_url]")
        .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, "[redacted_header]")
        .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
        .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted_token]")
        .replace(/(?:\\?["'])?\b(?:access_?token|refresh_?token|profile_?token|password|passwd|secret|token|jwt|signature|sig|api_?key|key|username|user_name|login|email|user|profile_?id|account_?id|session_?id)\b(?:\\?["'])?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s&;,}\]]+)/gi, "[redacted]")
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted_email]")
        .replace(/(?:~\/|\/(?:Users|home|var|tmp|data|mnt)\/)[^\s"']+/g, "[redacted_path]")
        .slice(0, LINE_LIMIT);
}

export class DiagnosticLog {
    sensitiveValues: readonly string[] = [];
    debug = false;
    capturing = false;
    dropped = 0;
    private lines: string[] = [];
    private next = 0;

    append(message: string): void {
        const line = redactDiagnostics(message, this.sensitiveValues);
        if (this.lines.length < CAPACITY) this.lines.push(line);
        else { this.lines[this.next] = line; this.next = (this.next + 1) % CAPACITY; this.dropped++; }
    }
    snapshot(): readonly string[] { return [...this.lines.slice(this.next), ...this.lines.slice(0, this.next)]; }
    clear(): void { this.lines = []; this.next = 0; this.dropped = 0; this.capturing = false; }
}
