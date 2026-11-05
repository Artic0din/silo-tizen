import { boolean, object, string } from "./wire.ts";

export function decodeDiagnosticsCapabilities(body: unknown): { readonly status: string; readonly available: boolean } {
    const row = object(body, "diagnostics");
    const allowed = boolean(row, "allowed", "diagnostics");
    const state = string(row, "state", "diagnostics");
    const available = allowed && state === "available";
    return { available, status: available ? "Available" : state === "not_configured" ? "Storage unavailable" : "Disabled by server" };
}
