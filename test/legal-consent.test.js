const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rootDir = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(rootDir, "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
const serverSource = fs.readFileSync(path.join(rootDir, "server.js"), "utf8");

test("signup form links to legal pages and requires explicit agreement", () => {
  assert.match(indexSource, /id="termsAgreement"/);
  assert.match(indexSource, /class="site-footer"/);
  assert.match(indexSource, /class="legal-links"/);
  assert.match(indexSource, /Copyright 2026 Appliva LLC/);
  assert.match(indexSource, /href="\/terms"/);
  assert.match(indexSource, /href="\/privacy"/);
  assert.match(appSource, /termsAgreementField\.classList\.toggle\("hidden", authMode !== "signup"\)/);
  assert.match(appSource, /authMode === "signup" && !termsAgreement\.checked/);
  assert.match(appSource, /acceptedTerms: authMode === "signup" \? termsAgreement\.checked : undefined/);
});

test("signup API rejects missing consent and records accepted policy versions", () => {
  assert.match(serverSource, /const policyVersion = "2026-08-13"/);
  assert.match(serverSource, /req\.body\?\.acceptedTerms !== true/);
  assert.match(serverSource, /Agree to the Terms and Privacy Policy to create an account\./);
  assert.match(serverSource, /terms_accepted_at timestamptz/);
  assert.match(serverSource, /terms_version text/);
  assert.match(serverSource, /privacy_version text/);
  assert.match(serverSource, /VALUES \(\$1, \$2, \$3, now\(\) \+ interval '24 hours', now\(\), \$4, \$5\)/);
  assert.match(serverSource, /\[email, passwordHash, verificationTokenHash, policyVersion, policyVersion\]/);
});

test("legal pages are served before the single-page app catch-all", () => {
  const termsRouteIndex = serverSource.indexOf('app.get("/terms"');
  const privacyRouteIndex = serverSource.indexOf('app.get("/privacy"');
  const catchAllIndex = serverSource.indexOf('app.get("*"');
  assert.ok(termsRouteIndex > -1);
  assert.ok(privacyRouteIndex > -1);
  assert.ok(catchAllIndex > -1);
  assert.ok(termsRouteIndex < catchAllIndex);
  assert.ok(privacyRouteIndex < catchAllIndex);
  assert.match(serverSource, /function renderTermsPage\(\)/);
  assert.match(serverSource, /function renderPrivacyPage\(\)/);
  assert.match(serverSource, /<h2>Use of AI<\/h2>/);
  assert.match(serverSource, /<h2>AI processing<\/h2>/);
  assert.match(serverSource, /const legalContactEmail = "info@appliva.io"/);
  assert.match(serverSource, /<h2>Fair use<\/h2>/);
  assert.match(serverSource, /monitor fair use, detect abuse, protect service reliability/);
  assert.match(serverSource, /Copyright 2026 Appliva LLC/);
});
