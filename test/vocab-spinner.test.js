const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const rootDir = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(rootDir, "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(rootDir, "styles.css"), "utf8");

test("vocab generate button shows a spinner while loading", () => {
  assert.match(indexSource, /id="generateBtn"[\s\S]*class="button-spinner hidden"/);
  assert.match(indexSource, /class="button-label">Generate/);
  assert.match(appSource, /function setGenerateLoading\(isLoading\)/);
  assert.match(appSource, /\[levelSelect, englishVariantSelect, vocabTargetLanguageSelect\]\.forEach/);
  assert.match(appSource, /control\.disabled = isLoading/);
  assert.match(appSource, /generateBtn\.setAttribute\("aria-busy", String\(isLoading\)\)/);
  assert.match(appSource, /generateBtnLabel\.textContent = isLoading \? "Generating\.\.\." : "Generate"/);
  assert.match(appSource, /generateBtnSpinner\.classList\.toggle\("hidden", !isLoading\)/);
  assert.match(appSource, /if \(generateBtn\.disabled\) return/);
  assert.match(appSource, /setGenerateLoading\(true\)/);
  assert.match(appSource, /setGenerateLoading\(false\)/);
  assert.match(stylesSource, /\.button-spinner/);
  assert.match(stylesSource, /#generateBtn:disabled/);
  assert.match(stylesSource, /#generateBtn\[aria-busy="true"\]/);
  assert.match(stylesSource, /@keyframes button-spin/);
});

test("vocab loading state disables dependent controls until generation finishes", () => {
  const loadingHelperMatch = appSource.match(/function setGenerateLoading\(isLoading\) \{[\s\S]*?\n\}/);
  assert.ok(loadingHelperMatch, "setGenerateLoading helper should exist");

  const levelSelect = { disabled: false };
  const englishVariantSelect = { disabled: false };
  const vocabTargetLanguageSelect = { disabled: false };
  const generateBtn = {
    disabled: false,
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
  const generateBtnLabel = { textContent: "Generate" };
  const generateBtnSpinner = {
    hidden: true,
    classList: {
      toggle(className, shouldHide) {
        assert.equal(className, "hidden");
        generateBtnSpinner.hidden = shouldHide;
      },
    },
  };

  const context = {
    levelSelect,
    englishVariantSelect,
    vocabTargetLanguageSelect,
    generateBtn,
    generateBtnLabel,
    generateBtnSpinner,
  };
  vm.runInNewContext(`${loadingHelperMatch[0]}; setGenerateLoading(true);`, context);

  assert.equal(levelSelect.disabled, true);
  assert.equal(englishVariantSelect.disabled, true);
  assert.equal(vocabTargetLanguageSelect.disabled, true);
  assert.equal(generateBtn.disabled, true);
  assert.equal(generateBtn.attributes["aria-busy"], "true");
  assert.equal(generateBtnLabel.textContent, "Generating...");
  assert.equal(generateBtnSpinner.hidden, false);

  vm.runInNewContext("setGenerateLoading(false);", context);

  assert.equal(levelSelect.disabled, false);
  assert.equal(englishVariantSelect.disabled, false);
  assert.equal(vocabTargetLanguageSelect.disabled, false);
  assert.equal(generateBtn.disabled, false);
  assert.equal(generateBtn.attributes["aria-busy"], "false");
  assert.equal(generateBtnLabel.textContent, "Generate");
  assert.equal(generateBtnSpinner.hidden, true);
});
