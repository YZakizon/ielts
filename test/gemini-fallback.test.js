const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

process.env.METRICS_FILE = "/tmp/ielts-gemini-fallback-test-metrics.json";
fs.rmSync(process.env.METRICS_FILE, { force: true });

const { configuredAiApiKeys, fetchGeneratedJson, fetchTtsAudio, renderMetrics } = require("../server");

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
      usageMetadata: { totalTokenCount: 42 },
    });
  };

  assert.deepEqual(await fetchGeneratedJson("Translate this"), { translation: "fallback worked" });
  assert.deepEqual(usedKeys, ["primary-key", "paid-key"]);
  const metrics = renderMetrics();
  assert.match(metrics, /ielts_ai_api_key_calls_total\{key_type="primary"\} 0/);
  assert.match(metrics, /ielts_ai_api_key_calls_total\{key_type="paid"\} 1/);
  assert.match(metrics, /ielts_ai_api_key_tokens_total\{key_type="primary"\} 0/);
  assert.match(metrics, /ielts_ai_api_key_tokens_total\{key_type="paid"\} 42/);
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

test("uses the paid Gemini key for TTS after a primary-key failure", async (t) => {
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
    const key = options.headers["x-goog-api-key"];
    usedKeys.push(key);
    if (key === "primary-key") return geminiResponse({ error: { message: "quota exceeded" } }, 429);
    return geminiResponse({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: Buffer.alloc(4800).toString("base64") } }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3200, totalTokenCount: 3202 },
    });
  };

  const generated = await fetchTtsAudio("Speak this");
  assert.deepEqual(usedKeys, ["primary-key", "paid-key"]);
  assert.equal(generated.keyType, "paid");
  assert.equal(generated.durationMs, 100);
  assert.equal(generated.wav.length, 4844);
});
