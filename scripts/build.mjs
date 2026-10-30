// Stage the Tizen web app in dist/wgt: static files from app/ plus one
// classic-script bundle of src/main.ts for the 2021 TV engine (Chromium 76).
import { build } from "esbuild";
import { cpSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stageDir = join(root, "dist", "wgt");
const config = readFileSync(join(root, "app", "config.xml"), "utf8");
const version = /<widget\b[^>]*\bversion="([^"]+)"/.exec(config)?.[1];
if (version === undefined) {
    throw new Error("The Tizen package version is missing");
}

rmSync(stageDir, { recursive: true, force: true });
cpSync(join(root, "app"), stageDir, { recursive: true });

await build({
    entryPoints: [join(root, "src", "main.ts")],
    outfile: join(stageDir, "js", "main.js"),
    bundle: true,
    format: "iife",
    target: "chrome76",
    define: { APP_VERSION: JSON.stringify(version) },
    logLevel: "info"
});
