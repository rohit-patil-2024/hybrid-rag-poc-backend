const {
  assertAiConfigured,
  generateJsonObject,
  getAiConfigSummary,
} = require("./openaiClient");

function normalizeTriples(rawTriples) {
  if (!Array.isArray(rawTriples)) {
    return [];
  }

  return rawTriples
    .map((triple) => ({
      source: String(triple?.source || "").trim(),
      relationship: String(triple?.relationship || "").trim(),
      target: String(triple?.target || "").trim(),
    }))
    .filter((triple) => triple.source && triple.relationship && triple.target);
}

async function extractTriplesFromText(textChunk) {
  assertAiConfigured();

  try {
    const ai = getAiConfigSummary();
    const parsed = await generateJsonObject({
      systemPrompt:
        "You extract knowledge graph triples from text. Return only valid JSON with this exact shape: {\"triples\":[{\"source\":\"Entity A\",\"relationship\":\"RELATIONSHIP_TYPE\",\"target\":\"Entity B\"}]}. Relationship values should be concise, uppercase with underscores when possible.\n\nStrict extraction rules:\n1) Do not over-summarize. If the text introduces a specific named concept, theory, or proper noun (for example: 'Plateau of Latent Potential', 'Lagging Measures'), you must extract that exact phrase as the Entity Name.\n2) Ensure abstract concepts are linked to the tangible actions or metaphors associated with them in the text.\n3) Prefer high-fidelity entities copied from the source wording instead of paraphrased entities.\n4) Return JSON only.",
      userPrompt: `Extract all useful entity-relationship triples from this text:\n\n${textChunk}`,
      temperature: 0,
      tracking: {
        task: "upload_document",
        operation: "triple_extraction",
        meta: {
          chunkLength: String(textChunk || "").length,
        },
      },
    });

    console.log(
      `[extractor] provider=${ai.provider} model=${ai.model} extractedTriples=${Array.isArray(parsed?.triples) ? parsed.triples.length : 0}`
    );

    return normalizeTriples(parsed.triples);
  } catch (error) {
    console.error("AI extraction failed:", error);
    throw error;
  }
}

module.exports = {
  extractTriplesFromText,
};
