// Settings > Server > Acknowledgements: the outside services whose data Silo shows, then the open
// source code built into this app. Copy follows silo-apple 1a7ccee `Screens/Settings/ThirdPartyCredits.swift`
// and `OpenSourceAcknowledgementsView.swift` (TVOpenSourceAcknowledgementsOverlay), listing only the
// services this app names or shows.

import { el } from "./screen.ts";

/** TMDB's approved "alt short" logo, shipped unmodified (app/third-party/README.md). */
export const TMDB_LOGO_PATH = "third-party/tmdb-logo.svg";

interface Credit {
    readonly name: string;
    readonly use: string;
    readonly notice?: string;
    readonly logo?: string;
}

const CREDITS: readonly Credit[] = [
    // TMDB's API terms (section 3) require this notice and TMDB's logo wherever its data is shown.
    {
        name: "TMDB",
        use: "Ratings, and the search results and discovery rows in Requests.",
        notice: "This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.",
        logo: TMDB_LOGO_PATH,
    },
    { name: "IMDb", use: "Ratings shown on titles, when your server provides them." },
    { name: "Rotten Tomatoes", use: "Critic and audience scores shown on titles, when your server provides them." },
    { name: "Common Sense Media and MDBList", use: "Suggested minimum viewer ages, when your server provides them." },
];

const TRADEMARK_NOTICE = "These names and logos belong to their owners. Silo is not affiliated with or endorsed by them.";

const OPEN_SOURCE: readonly string[] = [
    "Silo for Samsung TV is free software under the GNU Affero General Public License, version 3 or later, and comes with no warranty. Source code: https://github.com/Artic0din/silo-tizen",
    "ThumbHash decoder by Evan Wallace — MIT License",
    "unicode-segmenter by Hyeseong Kim — MIT License",
    "uqr — MIT License",
];

/** The passive document: credits first, then the trademark and open source notices. */
export function acknowledgementsDocument(): HTMLElement {
    const document = el("div", "acknowledgements-document");
    for (const credit of CREDITS) {
        const row = el("div", "acknowledgements-credit");
        if (credit.logo !== undefined) {
            // The logo replaces the name, smaller than Silo's own marks as TMDB's terms ask.
            const logo = el("img", "acknowledgements-logo");
            logo.src = credit.logo;
            logo.alt = credit.name;
            row.appendChild(logo);
        } else {
            row.appendChild(el("p", "acknowledgements-name", credit.name));
        }
        row.appendChild(el("p", "acknowledgements-detail", credit.use));
        if (credit.notice !== undefined) row.appendChild(el("p", "acknowledgements-detail", credit.notice));
        document.appendChild(row);
    }
    document.appendChild(el("p", "acknowledgements-detail", TRADEMARK_NOTICE));
    for (const line of OPEN_SOURCE) document.appendChild(el("p", "acknowledgements-license", line));
    return document;
}
