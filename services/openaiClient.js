require("dotenv").config();
const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { recordTokenUsage } = require("./tokenUsageTracker");

const AI_PROVIDER = String(process.env.AI_PROVIDER || "openai").toLowerCase();
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const OPENAI_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const GEMINI_FALLBACK_MODELS = [
  "gemini-2.0-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash",
  "gemini-1.5-pro-latest",
];

const openaiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })
  : null;

const geminiSdk = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

let resolvedGeminiModel = null;

function getActiveProvider() {
  if (AI_PROVIDER === "gemini") {
    return "gemini";
  }
  return "openai";
}

function getActiveModel() {
  return getActiveProvider() === "gemini" ? GEMINI_MODEL : OPENAI_MODEL;
}

function assertAiConfigured() {
  const provider = getActiveProvider();

  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured while AI_PROVIDER=openai.");
  }

  if (provider === "gemini" && !process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured while AI_PROVIDER=gemini.");
  }
}

function assertOpenAiForEmbeddings() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is required for embedding generation (text-embedding-3-small)."
    );
  }
}

function stripMarkdownJsonFences(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("```") || !raw.endsWith("```")) {
    return raw;
  }

  const lines = raw.split("\n");
  if (lines.length < 3) {
    return raw;
  }

  return lines.slice(1, -1).join("\n").trim();
}

function normalizeGeminiModelName(name) {
  const raw = String(name || "").trim();
  if (!raw) {
    return "";
  }

  return raw.startsWith("models/") ? raw.slice("models/".length) : raw;
}

async function fetchGeminiSupportedModels() {
  if (!process.env.GEMINI_API_KEY) {
    return [];
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
  );

  if (!response.ok) {
    throw new Error(`Failed to list Gemini models: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const models = Array.isArray(payload?.models) ? payload.models : [];

  return models
    .filter((model) => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes("generateContent"))
    .map((model) => normalizeGeminiModelName(model.name))
    .filter(Boolean);
}

async function resolveGeminiModel() {
  if (resolvedGeminiModel) {
    return resolvedGeminiModel;
  }

  const preferred = normalizeGeminiModelName(GEMINI_MODEL);
  let available = [];

  try {
    available = await fetchGeminiSupportedModels();
  } catch (error) {
    console.warn("[ai] Unable to fetch Gemini model list, using configured model as-is:", error.message);
  }

  if (available.length === 0) {
    resolvedGeminiModel = preferred;
    return resolvedGeminiModel;
  }

  if (available.includes(preferred)) {
    resolvedGeminiModel = preferred;
    return resolvedGeminiModel;
  }

  for (const candidate of GEMINI_FALLBACK_MODELS.map(normalizeGeminiModelName)) {
    if (available.includes(candidate)) {
      resolvedGeminiModel = candidate;
      console.warn(
        `[ai] GEMINI_MODEL=${preferred} is unavailable; using ${resolvedGeminiModel} instead.`
      );
      return resolvedGeminiModel;
    }
  }

  resolvedGeminiModel = available[0];
  console.warn(
    `[ai] GEMINI_MODEL=${preferred} is unavailable; using detected model ${resolvedGeminiModel}.`
  );
  return resolvedGeminiModel;
}

async function generateGeminiContent(combinedPrompt, temperature) {
  const preferred = await resolveGeminiModel();
  const candidates = [
    preferred,
    ...GEMINI_FALLBACK_MODELS.map(normalizeGeminiModelName).filter((model) => model && model !== preferred),
  ];

  let lastError = null;

  for (const modelName of candidates) {
    try {
      const model = geminiSdk.getGenerativeModel({ model: modelName });
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: combinedPrompt }] }],
        generationConfig: {
          temperature,
        },
      });

      if (resolvedGeminiModel !== modelName) {
        resolvedGeminiModel = modelName;
        console.warn(`[ai] Switched active Gemini model to ${modelName}.`);
      }

      return result;
    } catch (error) {
      lastError = error;
      if (Number(error?.status) === 404) {
        console.warn(`[ai] Gemini model ${modelName} returned 404; trying next candidate...`);
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("No working Gemini model found for generateContent.");
}

function buildTracking(tracking, defaults = {}) {
  return {
    task: String(tracking?.task || defaults.task || "unclassified"),
    operation: String(tracking?.operation || defaults.operation || "unknown"),
    requestId: tracking?.requestId,
    meta: tracking?.meta || {},
  };
}

function recordUsageForCall({ tracking, provider, model, usage, meta }) {
  const inputTokens = Number(usage?.prompt_tokens ?? usage?.promptTokenCount ?? 0);
  const outputTokens = Number(
    usage?.completion_tokens ?? usage?.candidatesTokenCount ?? 0
  );
  const totalTokens = Number(
    usage?.total_tokens ?? usage?.totalTokenCount ?? inputTokens + outputTokens
  );

  recordTokenUsage({
    task: tracking.task,
    operation: tracking.operation,
    provider,
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    meta: {
      ...tracking.meta,
      requestId: tracking.requestId,
      ...meta,
    },
  });
}

async function generateText({ systemPrompt, userPrompt, temperature = 0, tracking = {} }) {
  assertAiConfigured();
  const t = buildTracking(tracking, { operation: "text_generation" });

  const provider = getActiveProvider();
  if (provider === "openai") {
    const completion = await openaiClient.chat.completions.create({
      model: OPENAI_MODEL,
      temperature,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    recordUsageForCall({
      tracking: t,
      provider: "openai",
      model: OPENAI_MODEL,
      usage: completion?.usage,
    });

    return completion.choices?.[0]?.message?.content?.trim() || "";
  }

  const result = await generateGeminiContent(
    `${systemPrompt}\n\nUser query:\n${userPrompt}`,
    temperature
  );

  recordUsageForCall({
    tracking: t,
    provider: "gemini",
    model: resolvedGeminiModel || GEMINI_MODEL,
    usage: result?.response?.usageMetadata,
  });

  return result?.response?.text?.()?.trim() || "";
}

async function generateJsonObject({ systemPrompt, userPrompt, temperature = 0, tracking = {} }) {
  assertAiConfigured();
  const t = buildTracking(tracking, { operation: "json_generation" });

  const provider = getActiveProvider();
  if (provider === "openai") {
    const completion = await openaiClient.chat.completions.create({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      temperature,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    recordUsageForCall({
      tracking: t,
      provider: "openai",
      model: OPENAI_MODEL,
      usage: completion?.usage,
    });

    const responseText = completion.choices?.[0]?.message?.content;
    return JSON.parse(responseText || "{}");
  }

  const result = await generateGeminiContent(
    `${systemPrompt}\n\nReturn only strict JSON with no markdown fences.\n\nUser query:\n${userPrompt}`,
    temperature
  );

  recordUsageForCall({
    tracking: t,
    provider: "gemini",
    model: resolvedGeminiModel || GEMINI_MODEL,
    usage: result?.response?.usageMetadata,
  });

  const rawText = result?.response?.text?.() || "{}";
  const cleanText = stripMarkdownJsonFences(rawText);
  return JSON.parse(cleanText || "{}");
}

async function generateEmbedding(text, tracking = {}) {
  assertOpenAiForEmbeddings();
  const t = buildTracking(tracking, { operation: "embedding_generation" });

  const input = String(text || "").trim();
  if (!input) {
    return [];
  }

  const response = await openaiClient.embeddings.create({
    model: OPENAI_EMBEDDING_MODEL,
    input,
  });

  recordUsageForCall({
    tracking: t,
    provider: "openai",
    model: OPENAI_EMBEDDING_MODEL,
    usage: response?.usage,
    meta: {
      inputCount: 1,
    },
  });

  return response?.data?.[0]?.embedding || [];
}

async function generateEmbeddings(texts, tracking = {}) {
  assertOpenAiForEmbeddings();
  const t = buildTracking(tracking, { operation: "embedding_generation_batch" });

  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const normalized = texts.map((text) => String(text || "").trim());
  const response = await openaiClient.embeddings.create({
    model: OPENAI_EMBEDDING_MODEL,
    input: normalized,
  });

  recordUsageForCall({
    tracking: t,
    provider: "openai",
    model: OPENAI_EMBEDDING_MODEL,
    usage: response?.usage,
    meta: {
      inputCount: normalized.length,
    },
  });

  return Array.isArray(response?.data)
    ? response.data.map((item) => item.embedding || [])
    : [];
}

function getAiConfigSummary() {
  return {
    provider: getActiveProvider(),
    model: getActiveProvider() === "gemini" ? resolvedGeminiModel || getActiveModel() : getActiveModel(),
    embeddingModel: OPENAI_EMBEDDING_MODEL,
  };
}

module.exports = {
  AI_PROVIDER,
  OPENAI_MODEL,
  OPENAI_EMBEDDING_MODEL,
  GEMINI_MODEL,
  assertAiConfigured,
  assertOpenAiForEmbeddings,
  generateText,
  generateJsonObject,
  generateEmbedding,
  generateEmbeddings,
  getActiveProvider,
  getActiveModel,
  getAiConfigSummary,
};
