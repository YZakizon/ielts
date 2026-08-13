const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rootDir = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(rootDir, "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
const serverSource = fs.readFileSync(path.join(rootDir, "server.js"), "utf8");

const addedLanguages = [
  ["portuguese", "Portuguese"],
  ["italian", "Italian"],
  ["hindi", "Hindi"],
  ["urdu", "Urdu"],
  ["thai", "Thai"],
  ["vietnamese", "Vietnamese"],
  ["turkish", "Turkish"],
  ["russian", "Russian"],
  ["polish", "Polish"],
];

test("additional vocab target languages are available in UI and API labels", () => {
  for (const [value, label] of addedLanguages) {
    assert.match(indexSource, new RegExp(`<option value="${value}">${label}</option>`));
    assert.match(appSource, new RegExp(`${value}: "${label}"`));
    assert.match(serverSource, new RegExp(`${value}: "${label}"`));
  }
});
