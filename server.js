const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 80;
const metricsFile = process.env.METRICS_FILE || "/data/metrics.json";

const labels = {
  beginner: "Beginner",
  medium: "Medium",
  advance: "Advance",
  "more-advance": "More Advance",
};

const englishVariantLabels = {
  us: "US English",
  british: "British English",
};

const translationLanguageLabels = {
  auto: "the detected source language",
  english: "English",
  indonesian: "Bahasa Indonesia",
  spanish: "Spanish",
  french: "French",
  german: "German",
  arabic: "Arabic",
  "chinese-simplified": "Chinese Simplified",
  japanese: "Japanese",
  korean: "Korean",
};

const metrics = loadMetrics();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadMetrics() {
  try {
    const saved = JSON.parse(fs.readFileSync(metricsFile, "utf8"));
    return {
      aiCallsTotal: Number(saved.aiCallsTotal || 0),
      aiTokensTotal: Number(saved.aiTokensTotal || 0),
      distinctVocab: Array.isArray(saved.distinctVocab) ? saved.distinctVocab : [],
      uniqueUsersByDay: saved.uniqueUsersByDay || {},
      vocabByDay: saved.vocabByDay || {},
    };
  } catch {
    return {
      aiCallsTotal: 0,
      aiTokensTotal: 0,
      distinctVocab: [],
      uniqueUsersByDay: {},
      vocabByDay: {},
    };
  }
}

function saveMetrics() {
  try {
    fs.mkdirSync(path.dirname(metricsFile), { recursive: true });
    fs.writeFileSync(metricsFile, JSON.stringify(metrics, null, 2));
  } catch (error) {
    console.error(`Unable to save metrics: ${error.message}`);
  }
}

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((cookie) => cookie.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)]),
  );
}

function recordUniqueUser(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const userId =
    cookies.ielts_user_id ||
    (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

  if (!cookies.ielts_user_id) {
    res.cookie("ielts_user_id", userId, {
      httpOnly: false,
      maxAge: 365 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
    });
  }

  const day = todayKey();
  metrics.uniqueUsersByDay[day] = metrics.uniqueUsersByDay[day] || [];
  if (!metrics.uniqueUsersByDay[day].includes(userId)) {
    metrics.uniqueUsersByDay[day].push(userId);
    saveMetrics();
  }
}

function recordGeneratedWords(words) {
  const day = todayKey();
  metrics.vocabByDay[day] = (metrics.vocabByDay[day] || 0) + words.length;

  const distinct = new Set(metrics.distinctVocab);
  words.forEach((item) => {
    if (item?.word) {
      distinct.add(String(item.word).trim().toLowerCase());
    }
  });
  metrics.distinctVocab = [...distinct].sort();
  saveMetrics();
}

function recordAiUsage(data) {
  metrics.aiCallsTotal += 1;
  metrics.aiTokensTotal += Number(data.usageMetadata?.totalTokenCount || 0);
  saveMetrics();
}

function metricLine(name, value, labels = {}) {
  const labelEntries = Object.entries(labels);
  const renderedLabels = labelEntries.length
    ? `{${labelEntries.map(([key, val]) => `${key}="${String(val).replaceAll('"', '\\"')}"`).join(",")}}`
    : "";
  return `${name}${renderedLabels} ${value}`;
}

function renderMetrics() {
  const lines = [
    "# HELP ielts_ai_calls_total Total successful AI generation calls.",
    "# TYPE ielts_ai_calls_total counter",
    metricLine("ielts_ai_calls_total", metrics.aiCallsTotal),
    "# HELP ielts_ai_tokens_total Total AI tokens reported by the provider.",
    "# TYPE ielts_ai_tokens_total counter",
    metricLine("ielts_ai_tokens_total", metrics.aiTokensTotal),
    "# HELP ielts_distinct_vocab_total Number of distinct vocabulary words generated or searched.",
    "# TYPE ielts_distinct_vocab_total gauge",
    metricLine("ielts_distinct_vocab_total", metrics.distinctVocab.length),
    "# HELP ielts_vocab_per_day_total Number of vocabulary entries generated per day.",
    "# TYPE ielts_vocab_per_day_total counter",
    ...Object.entries(metrics.vocabByDay).map(([day, count]) =>
      metricLine("ielts_vocab_per_day_total", count, { day }),
    ),
    "# HELP ielts_unique_users_per_day Unique browser users per day.",
    "# TYPE ielts_unique_users_per_day gauge",
    ...Object.entries(metrics.uniqueUsersByDay).map(([day, users]) =>
      metricLine("ielts_unique_users_per_day", users.length, { day }),
    ),
  ];

  return `${lines.join("\n")}\n`;
}

function generationRequest(prompt) {
  const modelFamily = ["ge", "mini"].join("");
  const defaultModel = `${modelFamily}-3.5-flash-lite`;
  const requestedModel = process.env.AI_MODEL || defaultModel;
  const host = ["generative", "language.googleapis.com"].join("");
  const payload = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.AI_API_KEY,
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
      },
    }),
  };

  return { defaultModel, host, payload, requestedModel };
}

async function fetchGeneratedJson(prompt) {
  const { defaultModel, host, payload, requestedModel } = generationRequest(prompt);
  let response = await fetch(`https://${host}/v1beta/models/${requestedModel}:generateContent`, payload);

  if (response.status === 404 && requestedModel !== defaultModel) {
    response = await fetch(`https://${host}/v1beta/models/${defaultModel}:generateContent`, payload);
  }

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = await response.json();
  recordAiUsage(data);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Generation service returned an empty response.");
  }

  return JSON.parse(text);
}

app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  if (req.path !== "/metrics") {
    recordUniqueUser(req, res);
  }
  next();
});
app.use(express.static(__dirname));

app.get("/metrics", (_req, res) => {
  res.type("text/plain; version=0.0.4; charset=utf-8").send(renderMetrics());
});

app.post("/api/vocab", async (req, res) => {
  const { level, targetLanguage = "indonesian", variant } = req.body || {};

  if (
    !labels[level] ||
    !englishVariantLabels[variant] ||
    !translationLanguageLabels[targetLanguage] ||
    targetLanguage === "auto"
  ) {
    return res.status(400).json({ error: "Invalid level, English variant, or target language." });
  }

  if (!process.env.AI_API_KEY) {
    return res.status(503).json({ error: "AI_API_KEY is not configured." });
  }

  const targetLabel = translationLanguageLabels[targetLanguage];
  const prompt = `
Generate exactly 20 random IELTS vocabulary items for the "${labels[level]}" level.
Use ${englishVariantLabels[variant]} spelling and ${englishVariantLabels[variant]} IPA phonetic symbols.
Return only valid JSON with this shape:
{
  "words": [
    {
      "word": "English word",
      "phonetic": "/IPA symbols/",
      "translation": "${targetLabel} translation",
      "synonyms": ["synonym 1", "synonym 2", "synonym 3"],
      "usage": "Clear explanation in English about how to use the word.",
      "usageTranslation": "${targetLabel} translation of the usage explanation.",
      "example": "IELTS-style example sentence in English.",
      "exampleTranslation": "${targetLabel} translation of the example sentence."
    }
  ]
}
Use academic IELTS vocabulary, natural ${targetLabel} translations, and no markdown.
`;

  try {
    const generated = await fetchGeneratedJson(prompt);

    if (!Array.isArray(generated.words)) {
      return res.status(502).json({ error: "AI service returned invalid data." });
    }

    const words = generated.words.slice(0, 20);
    recordGeneratedWords(words);
    res.json({ words });
  } catch (error) {
    res.status(502).json({ error: error.message || "AI generation failed." });
  }
});

app.post("/api/search-vocab", async (req, res) => {
  const { query, targetLanguage = "indonesian", variant } = req.body || {};
  const word = String(query || "").trim();

  if (!word) {
    return res.status(400).json({ error: "Search word is required." });
  }

  if (!englishVariantLabels[variant] || !translationLanguageLabels[targetLanguage] || targetLanguage === "auto") {
    return res.status(400).json({ error: "Invalid English variant or target language." });
  }

  if (!process.env.AI_API_KEY) {
    return res.status(503).json({ error: "AI_API_KEY is not configured." });
  }

  const targetLabel = translationLanguageLabels[targetLanguage];
  const prompt = `
Create one IELTS vocabulary entry for "${word}".
Use ${englishVariantLabels[variant]} spelling and ${englishVariantLabels[variant]} IPA phonetic symbols.
If "${word}" is not a useful English IELTS vocabulary word, choose the closest useful IELTS vocabulary word.
Return only valid JSON with this shape:
{
  "word": "English word",
  "phonetic": "/IPA symbols/",
  "translation": "${targetLabel} translation",
  "synonyms": ["synonym 1", "synonym 2", "synonym 3"],
  "usage": "Clear explanation in English about how to use the word.",
  "usageTranslation": "${targetLabel} translation of the usage explanation.",
  "example": "IELTS-style example sentence in English.",
  "exampleTranslation": "${targetLabel} translation of the example sentence."
}
Use natural ${targetLabel} translations and no markdown.
`;

  try {
    const generated = await fetchGeneratedJson(prompt);
    if (!generated.word) {
      return res.status(502).json({ error: "Generation service returned invalid data." });
    }
    recordGeneratedWords([generated]);
    res.json({ word: generated });
  } catch (error) {
    res.status(502).json({ error: error.message || "Search generation failed." });
  }
});

app.post("/api/translate-sentence", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  const sourceLanguage = String(req.body?.sourceLanguage || "auto");
  const targetLanguage = String(req.body?.targetLanguage || "english");

  if (!text) {
    return res.status(400).json({ error: "Sentence text is required." });
  }

  if (text.length > 800) {
    return res.status(400).json({ error: "Sentence text must be 800 characters or fewer." });
  }

  if (!translationLanguageLabels[sourceLanguage] || !translationLanguageLabels[targetLanguage]) {
    return res.status(400).json({ error: "Invalid source or target language." });
  }

  if (targetLanguage === "auto") {
    return res.status(400).json({ error: "Target language must be selected." });
  }

  if (!process.env.AI_API_KEY) {
    return res.status(503).json({ error: "AI_API_KEY is not configured." });
  }

  const sourceLabel = translationLanguageLabels[sourceLanguage];
  const targetLabel = translationLanguageLabels[targetLanguage];
  const needsIeltsFeedback = sourceLanguage === "english";
  const prompt = `
Translate this sentence or short paragraph from ${sourceLabel} into natural ${targetLabel}:
"${text.replaceAll('"', '\\"')}"

Return only valid JSON with this shape:
{
  "translation": "Natural ${targetLabel} translation",
  "keyPhrases": [
    { "source": "important source phrase", "target": "meaning in ${targetLabel}" }
  ],
  "notes": [
    "Short grammar or word-choice note for IELTS learners"
  ],
  "ieltsFeedback": {
    "correctedSentence": "${needsIeltsFeedback ? "Corrected English sentence, or the original if already correct" : ""}",
    "corrections": ${needsIeltsFeedback ? '["Specific grammar, spelling, or word-choice correction"]' : "[]"},
    "suggestions": ${needsIeltsFeedback ? '["IELTS-focused suggestion to make the sentence more academic, accurate, or natural"]' : "[]"}
  }
}
${needsIeltsFeedback ? "Because the source language is English, provide concise correction and IELTS learner suggestions." : "Because the source language is not English, leave ieltsFeedback fields empty."}
Keep the translation faithful to the original meaning. Use natural ${targetLabel}, no markdown, and no extra keys.
`;

  try {
    const generated = await fetchGeneratedJson(prompt);
    if (!generated.translation) {
      return res.status(502).json({ error: "AI service returned invalid translation data." });
    }
    res.json(generated);
  } catch (error) {
    res.status(502).json({ error: error.message || "Sentence translation failed." });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, () => {
  console.log(`IELTS app listening on port ${port}`);
});
