// Draws a QR code as inline SVG, encoded on the TV: the link never goes to an image service.

import { encode } from "uqr";

const SVG_NS = "http://www.w3.org/2000/svg";
/** The four-module light margin the QR specification requires around the symbol. */
const QUIET_ZONE = 4;

export function qrCode(text: string, label: string): SVGSVGElement | undefined {
    // Medium error correction still reads when glare or a camera angle hides part of the code.
    let qr: ReturnType<typeof encode>;
    try {
        qr = encode(text, { ecc: "M", border: QUIET_ZONE });
    } catch {
        return undefined;
    }
    let path = "";
    qr.data.forEach((row, y) => {
        row.forEach((dark, x) => {
            if (dark) {
                path += `M${x} ${y}h1v1h-1z`;
            }
        });
    });
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "signin-qr");
    svg.setAttribute("viewBox", `0 0 ${qr.size} ${qr.size}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    svg.setAttribute("shape-rendering", "crispEdges");
    const light = document.createElementNS(SVG_NS, "rect");
    light.setAttribute("width", String(qr.size));
    light.setAttribute("height", String(qr.size));
    light.setAttribute("fill", "#fff");
    const modules = document.createElementNS(SVG_NS, "path");
    modules.setAttribute("d", path);
    modules.setAttribute("fill", "#000");
    svg.appendChild(light);
    svg.appendChild(modules);
    return svg;
}
