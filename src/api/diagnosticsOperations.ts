import { decodeDiagnosticsCapabilities } from "../contracts/v2/diagnostics.ts";
import type { RequestSpec } from "./http.ts";

export function diagnosticsCapabilities(): RequestSpec<ReturnType<typeof decodeDiagnosticsCapabilities>> {
    return { method: "GET", path: "/diagnostics/capabilities", retry: "safe", decode: decodeDiagnosticsCapabilities };
}
