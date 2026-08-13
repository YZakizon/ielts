const DEFAULT_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const DEFAULT_TTS_VOICE = "Achernar";
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_SAMPLE_WIDTH = 2;

function ttsRequest(text, apiKey, env = process.env) {
  const model = String(env.TTS_MODEL || DEFAULT_TTS_MODEL).trim();
  const voice = String(env.TTS_VOICE || DEFAULT_TTS_VOICE).trim();
  const host = ["generative", "language.googleapis.com"].join("");
  return {
    host,
    model,
    voice,
    payload: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `Read this transcript exactly as written.\n\nTRANSCRIPT:\n${text}` }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice },
            },
          },
        },
      }),
    },
  };
}

function parsePcmMimeType(mimeType = "") {
  const rateMatch = String(mimeType).match(/rate=(\d+)/i);
  return {
    channels: DEFAULT_CHANNELS,
    sampleRate: rateMatch ? Number(rateMatch[1]) : DEFAULT_SAMPLE_RATE,
    sampleWidth: DEFAULT_SAMPLE_WIDTH,
  };
}

function pcmDurationMs(pcm, format = {}) {
  const sampleRate = Number(format.sampleRate || DEFAULT_SAMPLE_RATE);
  const channels = Number(format.channels || DEFAULT_CHANNELS);
  const sampleWidth = Number(format.sampleWidth || DEFAULT_SAMPLE_WIDTH);
  if (!Buffer.isBuffer(pcm) || !pcm.length || sampleRate <= 0 || channels <= 0 || sampleWidth <= 0) {
    throw new Error("TTS service returned invalid audio data.");
  }
  return Math.ceil((pcm.length * 1000) / (sampleRate * channels * sampleWidth));
}

function pcmToWav(pcm, format = {}) {
  const sampleRate = Number(format.sampleRate || DEFAULT_SAMPLE_RATE);
  const channels = Number(format.channels || DEFAULT_CHANNELS);
  const sampleWidth = Number(format.sampleWidth || DEFAULT_SAMPLE_WIDTH);
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * sampleWidth;
  const blockAlign = channels * sampleWidth;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(sampleWidth * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function extractTtsAudio(data) {
  const part = data?.candidates?.[0]?.content?.parts?.find((item) => item.inlineData?.data);
  if (!part?.inlineData?.data) {
    throw new Error("TTS service returned an empty response.");
  }
  const pcm = Buffer.from(part.inlineData.data, "base64");
  const format = parsePcmMimeType(part.inlineData.mimeType);
  const durationMs = pcmDurationMs(pcm, format);
  return {
    durationMs,
    format,
    inputTokens: Number(data.usageMetadata?.promptTokenCount || 0),
    outputTokens: Number(data.usageMetadata?.candidatesTokenCount || 0),
    totalTokens: Number(data.usageMetadata?.totalTokenCount || 0),
    wav: pcmToWav(pcm, format),
  };
}

module.exports = {
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
  extractTtsAudio,
  pcmDurationMs,
  pcmToWav,
  ttsRequest,
};
