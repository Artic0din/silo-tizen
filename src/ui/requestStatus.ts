const LABELS: Readonly<Record<string, string>> = {
    pending: "Pending",
    approved: "Approved",
    processing: "Processing",
    partially_available: "Partly available",
    available: "Available",
    declined: "Declined",
    cancelled: "Cancelled",
    failed: "Failed",
};

/** Plain label for a server request state; an unlisted state is shown as sentence-case words. */
export function requestStateLabel(state: string): string {
    const known = LABELS[state];
    if (known !== undefined) return known;
    const words = state.replace(/_/g, " ").trim().toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}
