const assert = require("node:assert/strict");
const test = require("node:test");

const { extractTtsAudio, pcmDurationMs, pcmToWav, ttsRequest } = require("../tts");

test("builds a Gemini 2.5 Flash TTS request with Achernar", () => {
  const request = ttsRequest("Hello", "secret", {});
  const body = JSON.parse(request.payload.body);
  assert.equal(request.model, "gemini-2.5-flash-preview-tts");
  assert.equal(request.voice, "Achernar");
  assert.deepEqual(body.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Achernar");
  assert.equal(request.payload.headers["x-goog-api-key"], "secret");
});

test("wraps 24 kHz mono PCM in WAV and calculates exact duration", () => {
  const pcm = Buffer.alloc(48000);
  assert.equal(pcmDurationMs(pcm), 1000);
  const wav = pcmToWav(pcm);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.length, pcm.length + 44);
});

test("extracts audio, duration, and provider token metadata", () => {
  const pcm = Buffer.alloc(24000);
  const result = extractTtsAudio({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm.toString("base64") } }] } }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 16000, totalTokenCount: 16003 },
  });
  assert.equal(result.durationMs, 500);
  assert.equal(result.inputTokens, 3);
  assert.equal(result.outputTokens, 16000);
  assert.equal(result.totalTokens, 16003);
  assert.equal(result.wav.length, pcm.length + 44);
});

test("rejects empty TTS audio", () => {
  assert.throws(() => extractTtsAudio({ candidates: [] }), /empty response/);
});
