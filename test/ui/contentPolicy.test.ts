import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

test("the shipped policy renders sign-in grain and confines objects to the app origin", async () => {
    const config = readFileSync(new URL("../../dist/wgt/config.xml", import.meta.url), "utf8");
    // Reproduce WRT's default when the package does not override it.
    const policy = config.match(/<tizen:content-security-policy>([^<]+)<\/tizen:content-security-policy>/)?.[1]
        ?? "default-src *; script-src 'self'; style-src 'self'; object-src 'none';";
    const bundle = await build({
        stdin: { contents: `
            import { MarqueeBackdrop } from './src/ui/marqueeBackdrop.ts';
            import { systemClock } from './src/api/clock.ts';
            document.body.append(new MarqueeBackdrop(systemClock).element);
        `, resolveDir: process.cwd() },
        bundle: true, write: false, format: "iife", platform: "browser", target: "chrome108",
    });
    const script = bundle.outputFiles[0];
    assert.ok(script);
    const server = createServer((request, response) => {
        response.setHeader("Content-Security-Policy", policy);
        if (request.url === "/app.js") {
            response.setHeader("Content-Type", "text/javascript");
            response.end(script.text);
        } else if (request.url === "/image.svg") {
            response.setHeader("Content-Type", "image/svg+xml");
            response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
        } else {
            response.setHeader("Content-Type", "text/html");
            response.end('<!doctype html><body><script src="/app.js"></script>');
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${address.port}`);
        await page.locator(".marquee-backdrop-grain").waitFor({ state: "attached" });
        const grain = await page.locator(".marquee-backdrop-grain").evaluate(async element => {
            const image = new Image();
            image.src = element instanceof HTMLElement ? element.style.backgroundImage.slice(5, -2) : "";
            try { await image.decode(); return image.naturalWidth; } catch { return 0; }
        });
        assert.equal(grain, 96, "the real generated grain image loads under the package policy");
        const objects = await page.evaluate(async () => {
            const own = document.createElement("object");
            own.data = "/image.svg";
            const loaded = new Promise<boolean>(resolve => { own.onload = () => resolve(true); own.onerror = () => resolve(false); });
            document.body.append(own);
            const ownLoaded = await loaded;
            const blocked = new Promise<string>(resolve => {
                document.addEventListener("securitypolicyviolation", event => resolve(event.effectiveDirective), { once: true });
            });
            const foreign = document.createElement("object");
            foreign.data = `${location.origin.replace("127.0.0.1", "localhost")}/image.svg`;
            document.body.append(foreign);
            return { ownLoaded, blockedDirective: await blocked };
        });
        assert.deepEqual(objects, { ownLoaded: true, blockedDirective: "object-src" });
    } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
