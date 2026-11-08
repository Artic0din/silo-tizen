import assert from "node:assert/strict";
import { test } from "node:test";
import { signOutConfirmationCopy, signOutRemovesServer } from "../../src/ui/signOutConfirmation.ts";

const REMOVED = "This account's profiles and settings leave this TV, and Living room will be removed from it.";
const STAYS = "This account's profiles and settings leave this TV. The server stays saved, so you can sign in again.";

test("sign-out removes a server only when these are its last saved accounts", () => {
    const accounts = [{ baseUrl: "https://silo.example" }, { baseUrl: "https://silo.example" }, { baseUrl: "https://other.example" }];
    assert.equal(signOutRemovesServer(() => accounts, "https://silo.example"), false);
    assert.equal(signOutRemovesServer(() => accounts, "https://silo.example", 2), true);
    assert.equal(signOutRemovesServer(() => accounts, "https://other.example"), true);
    assert.equal(signOutRemovesServer(() => { throw new Error("Account list unavailable"); }, "https://silo.example"), false);
    assert.equal(signOutConfirmationCopy("laura", "Living room", true).message, REMOVED);
    assert.equal(signOutConfirmationCopy("laura", "Living room", false).message, STAYS);
    assert.equal(signOutConfirmationCopy("laura", "Living room", false).title, "Sign out of laura on Living room?");
});
