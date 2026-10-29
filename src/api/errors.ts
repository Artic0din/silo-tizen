import type { Problem } from "../contracts/v2/wire.ts";

export type ApiFailure =
    /** No HTTP answer: DNS, TLS, refused connection, CORS refusal or a redirect (refused by design). */
    | { readonly kind: "network" }
    | { readonly kind: "timeout" }
    /** The caller, or a change of account/profile authority, abandoned the request. */
    | { readonly kind: "aborted" }
    | { readonly kind: "problem"; readonly problem: Problem; readonly retryAfterSeconds: number | undefined }
    /** An error status without Problem Details, e.g. from a proxy. */
    | { readonly kind: "http"; readonly status: number; readonly retryAfterSeconds: number | undefined }
    | { readonly kind: "invalid_response"; readonly path: string };

export class ApiError extends Error {
    readonly failure: ApiFailure;

    constructor(failure: ApiFailure) {
        super(describe(failure));
        this.name = "ApiError";
        this.failure = failure;
    }

    /** HTTP status when the server answered, else undefined. */
    get status(): number | undefined {
        const failure = this.failure;
        if (failure.kind === "problem") {
            return failure.problem.status;
        }
        return failure.kind === "http" ? failure.status : undefined;
    }

    /** Problem identifier (final segment of the problem `type`), when present. */
    get problemId(): string | undefined {
        return this.failure.kind === "problem" ? this.failure.problem.id : undefined;
    }

    get retryAfterSeconds(): number | undefined {
        const failure = this.failure;
        return failure.kind === "problem" || failure.kind === "http" ? failure.retryAfterSeconds : undefined;
    }

    get aborted(): boolean {
        return this.failure.kind === "aborted";
    }

    /** No answer, a timeout, a rate limit or a server-side failure: the same request may work later. */
    get transient(): boolean {
        const kind = this.failure.kind;
        if (kind === "network" || kind === "timeout") {
            return true;
        }
        const status = this.status;
        return status !== undefined && (status === 408 || status === 429 || status >= 500);
    }
}

function describe(failure: ApiFailure): string {
    switch (failure.kind) {
        case "problem":
            return `Silo answered ${failure.problem.status} ${failure.problem.id}`;
        case "http":
            return `Silo answered HTTP ${failure.status}`;
        case "invalid_response":
            return `Unexpected response at ${failure.path}`;
        default:
            return `Request failed: ${failure.kind}`;
    }
}
