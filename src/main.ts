import { boot } from "./bootstrap.ts";
import "./theme.css";
import "./app.css";
import "./ui/signIn.css";
import "./ui/browse.css";
import "./player/player.css";

const root = document.getElementById("screen");
if (root === null) {
    throw new Error("Silo's screen is missing");
}
export const app = boot(root, APP_VERSION);
