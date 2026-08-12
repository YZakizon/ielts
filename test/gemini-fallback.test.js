const assert = require("node:assert/strict");
const test = require("node:test");

process.env.METRICS_FILE = "/tmp/ielts-gemini-fallback-test-metrics.json";

const { configuredAiApiKeys, fetchGeneratedJson } = require("../server");

function geminiResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

test("uses the paid Gemini key after the primary key returns an error", async (t) => {
  const originalFetch = global.fetch;
  const originalPrimaryKey = process.env.AI_API_KEY;
  const originalPaidKey = process.env.GEMINI_API_KEY_PAID;
  const usedKeys = [];

  t.after(() => {
    global.fetch = originalFetch;
    process.env.AI_API_KEY = originalPrimaryKey;
    process.env.GEMINI_API_KEY_PAID = originalPaidKey;
  });

  process.env.AI_API_KEY = "primary-key";
  process.env.GEMINI_API_KEY_PAID = "paid-key";
  global.fetch = async (_url, options) => {
    const apiKey = options.headers["x-goog-api-key"];
    usedKeys.push(apiKey);
    if (apiKey === "primary-key") {
      return geminiResponse({ error: { message: "quota exceeded" } }, 429);
    }
    return geminiResponse({
      candidates: [{ content: { parts: [{ text: '{"translation":"fallback worked"}' }] } }],
    });
  };

  assert.deepEqual(await fetchGeneratedJson("Translate this"), { translation: "fallback worked" });
  assert.deepEqual(usedKeys, ["primary-key", "paid-key"]);
});

test("allows the paid key to be the only configured Gemini key", () => {
  assert.deepEqual(configuredAiApiKeys({ GEMINI_API_KEY_PAID: " paid-key " }), ["paid-key"]);
});

test("does not retry the same key when both variables match", () => {
  assert.deepEqual(
    configuredAiApiKeys({ AI_API_KEY: "same-key", GEMINI_API_KEY_PAID: "same-key" }),
    ["same-key"],
  );
});
