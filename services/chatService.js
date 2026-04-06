const { driver } = require("../neo4j");
const {
  assertAiConfigured,
  generateText,
  generateEmbedding,
  OPENAI_EMBEDDING_MODEL,
  getAiConfigSummary,
} = require("./openaiClient");

const EMBEDDING_DIMENSIONS_BY_MODEL = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

function getEmbeddingDimensions() {
  return EMBEDDING_DIMENSIONS_BY_MODEL[OPENAI_EMBEDDING_MODEL] || 1536;
}

function logWithRequestId(requestId, message, extra) {
  const prefix = requestId ? `[${requestId}]` : "[chat]";
  if (typeof extra === "undefined") {
    console.log(`${prefix} ${message}`);
    return;
  }
  console.log(`${prefix} ${message}`, extra);
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "what",
  "which",
  "who",
  "whom",
  "where",
  "when",
  "why",
  "how",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "from",
  "by",
  "that",
  "this",
  "it",
  "if",
  "they",
  "them",
  "their",
]);

function extractKeywords(question) {
  const tokens = String(question || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));

  return [...new Set(tokens)].slice(0, 12);
}

function buildTriplesFromPaths(paths) {
  const unique = new Set();
  const triples = [];

  for (const path of paths) {
    if (!path || !Array.isArray(path.segments)) {
      continue;
    }

    for (const segment of path.segments) {
      const source = String(segment.start?.properties?.name || "").trim();
      const relationship = String(segment.relationship?.type || "").trim();
      const target = String(segment.end?.properties?.name || "").trim();
      const relProps = segment.relationship?.properties || {};

      if (!source || !relationship || !target) {
        continue;
      }

      const evidenceChunksRaw = relProps.evidenceChunks;
      const evidenceChunks = Array.isArray(evidenceChunksRaw)
        ? evidenceChunksRaw.map((chunk) => String(chunk || "").trim()).filter(Boolean)
        : [];
      const sourceTextChunk = String(relProps.sourceTextChunk || "").trim();
      if (sourceTextChunk && !evidenceChunks.includes(sourceTextChunk)) {
        evidenceChunks.push(sourceTextChunk);
      }

      const key = `${source}|${relationship}|${target}`;
      if (unique.has(key)) {
        continue;
      }

      unique.add(key);
      triples.push({ source, relationship, target, evidenceChunks });
    }
  }

  return triples;
}

async function ensureVectorIndexExists(session, requestId) {
  const dimensions = getEmbeddingDimensions();

  try {
    await session.run(
      `
        CREATE VECTOR INDEX entity_embedding_index IF NOT EXISTS
        FOR (e:Entity) ON (e.embedding)
        OPTIONS {
          indexConfig: {
            \`vector.dimensions\`: ${dimensions},
            \`vector.similarity_function\`: 'cosine'
          }
        }
      `
    );

    const stateResult = await session.run(
      `
        SHOW VECTOR INDEXES
        YIELD name, state
        WHERE name = 'entity_embedding_index'
        RETURN name, state
        LIMIT 1
      `
    );

    if (stateResult.records.length > 0) {
      const state = String(stateResult.records[0].get("state") || "");
      logWithRequestId(requestId, `Vector index status: entity_embedding_index (${state}).`);
    } else {
      logWithRequestId(
        requestId,
        "Vector index ensure executed, but index metadata not found yet."
      );
    }
  } catch (error) {
    console.error(
      `${requestId ? `[${requestId}] ` : ""}Failed to ensure vector index entity_embedding_index:`,
      error
    );
    throw error;
  }
}

async function fetchHybridGraphContext(questionEmbedding, requestId, topK = 3) {
  const session = driver.session();
  const safeTopK = Math.max(1, Math.trunc(Number(topK) || 3));

  try {
    await ensureVectorIndexExists(session, requestId);
    logWithRequestId(requestId, `Running vector search for top ${safeTopK} entry nodes...`);

    const result = await session.executeRead((tx) =>
      tx.run(
        `
          CALL db.index.vector.queryNodes('entity_embedding_index', $topK, $questionEmbedding)
          YIELD node, score
          WITH node, score
          ORDER BY score DESC
          WITH collect({id: id(node), name: node.name, score: score}) AS entries
          UNWIND entries AS entry
          MATCH (entryNode:Entity)
          WHERE id(entryNode) = entry.id
          OPTIONAL MATCH p = (entryNode)-[*1..2]-(connected:Entity)
          RETURN entryNode.name AS entryName, entry.score AS similarity, collect(DISTINCT p)[0..80] AS paths
          ORDER BY similarity DESC
        `,
        {
          topK: safeTopK,
          questionEmbedding,
        }
      )
    );

    const entryNodes = [];
    const mergedTriples = [];
    const dedup = new Set();

    for (const record of result.records) {
      const entryName = String(record.get("entryName") || "").trim();
      const similarity = Number(record.get("similarity") || 0);
      const paths = record.get("paths") || [];
      const triples = buildTriplesFromPaths(paths);

      if (entryName) {
        entryNodes.push({ name: entryName, similarity: Number(similarity.toFixed(4)) });
      }

      for (const triple of triples) {
        const key = `${triple.source}|${triple.relationship}|${triple.target}`;
        if (dedup.has(key)) {
          continue;
        }
        dedup.add(key);
        mergedTriples.push(triple);
      }
    }

    logWithRequestId(
      requestId,
      `Hybrid retrieval complete. entryNodes=${entryNodes.length} triples=${mergedTriples.length}`
    );
    if (entryNodes.length > 0) {
      logWithRequestId(requestId, "Vector entry nodes:", entryNodes);
    }
    if (mergedTriples.length > 0) {
      logWithRequestId(
        requestId,
        "Graph extraction payload:",
        mergedTriples.slice(0, 20).map((triple) => ({
          source: triple.source,
          relationship: triple.relationship,
          target: triple.target,
          evidencePreview: (triple.evidenceChunks[0] || "").slice(0, 140),
        }))
      );
    }

    return {
      entryNodes,
      triples: mergedTriples,
    };
  } catch (error) {
    console.error(`${requestId ? `[${requestId}] ` : ""}Hybrid graph retrieval failed:`, error);
    throw error;
  } finally {
    await session.close();
  }
}

async function fetchKeywordGraphContext(tokens, requestId, limit = 80) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return {
      keywordTriples: [],
      keywordNodes: [],
    };
  }

  const session = driver.session();
  const safeLimit = Math.max(1, Math.trunc(Number(limit) || 80));
  try {
    logWithRequestId(requestId, `Running keyword graph retrieval for tokens: ${tokens.join(", ")}`);

    const result = await session.executeRead((tx) =>
      tx.run(
        `
          MATCH (s:Entity)-[r]-(t:Entity)
          WITH s, r, t,
            reduce(score = 0, token IN $tokens |
              score +
              CASE WHEN toLower(s.name) CONTAINS token THEN 3 ELSE 0 END +
              CASE WHEN toLower(t.name) CONTAINS token THEN 3 ELSE 0 END +
              CASE WHEN toLower(type(r)) CONTAINS token THEN 1 ELSE 0 END
            ) AS lexicalScore
          WHERE lexicalScore > 0
          RETURN s.name AS source,
                 type(r) AS relationship,
                 t.name AS target,
                 coalesce(r.evidenceChunks, []) AS evidenceChunks,
                 coalesce(r.sourceTextChunk, '') AS sourceTextChunk,
                 lexicalScore
          ORDER BY lexicalScore DESC
          LIMIT toInteger($limit)
        `,
        { tokens, limit: safeLimit }
      )
    );

    const dedup = new Set();
    const keywordTriples = [];
    const nodeSet = new Set();

    for (const record of result.records) {
      const source = String(record.get("source") || "").trim();
      const relationship = String(record.get("relationship") || "").trim();
      const target = String(record.get("target") || "").trim();
      if (!source || !relationship || !target) {
        continue;
      }

      const key = `${source}|${relationship}|${target}`;
      if (dedup.has(key)) {
        continue;
      }
      dedup.add(key);

      const evidenceChunksRaw = record.get("evidenceChunks") || [];
      const evidenceChunks = Array.isArray(evidenceChunksRaw)
        ? evidenceChunksRaw.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
      const sourceTextChunk = String(record.get("sourceTextChunk") || "").trim();
      if (sourceTextChunk && !evidenceChunks.includes(sourceTextChunk)) {
        evidenceChunks.push(sourceTextChunk);
      }

      keywordTriples.push({ source, relationship, target, evidenceChunks });
      nodeSet.add(source);
      nodeSet.add(target);
    }

    const keywordNodes = [...nodeSet].slice(0, 10).map((name) => ({
      name,
      similarity: "keyword",
    }));

    logWithRequestId(
      requestId,
      `Keyword retrieval complete. nodes=${keywordNodes.length} triples=${keywordTriples.length}`
    );

    return {
      keywordTriples,
      keywordNodes,
    };
  } catch (error) {
    console.error(`${requestId ? `[${requestId}] ` : ""}Keyword graph retrieval failed:`, error);
    throw error;
  } finally {
    await session.close();
  }
}

function mergeTriples(vectorTriples, keywordTriples) {
  const dedup = new Set();
  const merged = [];

  for (const triple of [...(vectorTriples || []), ...(keywordTriples || [])]) {
    const key = `${triple.source}|${triple.relationship}|${triple.target}`;
    if (dedup.has(key)) {
      continue;
    }
    dedup.add(key);
    merged.push(triple);
  }

  return merged;
}

function formatHybridContext(entryNodes, triples) {
  if (!Array.isArray(entryNodes) || entryNodes.length === 0) {
    return "No entry nodes were found via vector similarity search.";
  }

  const entryLines = entryNodes
    .slice(0, 3)
    .map((entry) => `- ${entry.name} (similarity: ${entry.similarity})`);

  if (!Array.isArray(triples) || triples.length === 0) {
    return [
      "Vector entry nodes:",
      ...entryLines,
      "No connected triples were found within 1-2 hops from the entry nodes.",
    ].join("\n");
  }

  const tripleLines = triples.slice(0, 80).map((triple) => {
    const evidence = triple.evidenceChunks?.[0]
      ? ` | evidence: \"${triple.evidenceChunks[0].slice(0, 280)}\"`
      : "";
    return `- ${triple.source} -[${triple.relationship}]-> ${triple.target}${evidence}`;
  });

  return [
    "Vector entry nodes:",
    ...entryLines,
    "",
    "Connected graph relationships with source text evidence:",
    ...tripleLines,
  ].join("\n");
}

function buildBaseInstructions(roleBlock) {
  return `
${roleBlock}

# Conversation Guidelines
- Conduct concise and purposeful 1:1 interactions.
- You will receive:
  - A user question
  - Retrieved graph context
- All available evidence is already appended within these instructions.
- Carefully review the provided reference information and respond ONLY based on it.
- Ask clarifying questions only if the information is unclear, incomplete, or contradictory.
- Maintain a professional, calm, and conversational tone.
- Do NOT use emojis.
- Do NOT introduce information that is not present in the provided data.

# Reference Data (Source of Truth)
You may ONLY use the following retrieved graph context to answer questions:

# Source Priority Rule (MANDATORY)
- If overlapping, duplicate, misleading, or contradictory facts are present:
  - Prefer facts that include explicit evidence text snippets.
  - Prefer facts that are repeated across multiple retrieved relationships.
- You MUST NOT merge conflicting claims into one statement.
- If conflict cannot be resolved from the provided context, state uncertainty clearly.
`;
}

function appendGraphContext(graphContext) {
  return `
## Retrieved Graph Context
${String(graphContext || "No retrieved graph context was provided.")}
`;
}

function buildOutputRules() {
  return `
# Output Format (STRICT)
- Return plain text only.
- Do NOT return JSON.
- Do NOT return markdown.
- Do NOT include HTML.

# Answer Rules (MANDATORY)
- Provide the factual answer directly using only the retrieved context.
- Keep the answer concise and specific.
- If the context is partial, answer only the supported portion and state what is missing.
- If the answer is not available in context, reply exactly:
  I could not find enough information in the uploaded knowledge base to answer this question.
`;
}

function buildGraphRagAnswerInstructions(graphContext) {
  const role = `
# Role
You are a GraphRAG FAQ Agent specialized in answering factual questions strictly using retrieved Neo4j graph evidence.

# Behavior Rules
- Use ONLY explicitly stated facts from the retrieved context.
- Do NOT infer, assume, or use outside knowledge.
- Synthesize across multiple retrieved facts only when they are compatible.
`;

  return `${buildBaseInstructions(role)}\n${appendGraphContext(graphContext)}\n${buildOutputRules()}`;
}

async function generateContextualAnswer(question, graphContext, requestId, hasGraphEvidence) {
  assertAiConfigured();

  try {
    const ai = getAiConfigSummary();
    logWithRequestId(
      requestId,
      `Generating final answer using provider=${ai.provider} model=${ai.model}...`
    );

    const systemPrompt = hasGraphEvidence
      ? buildGraphRagAnswerInstructions(graphContext)
      : "You are a GraphRAG assistant. There is no relevant retrieved context. Reply exactly: 'I could not find enough information in the uploaded knowledge base to answer this question.'";

    const answer = await generateText({
      systemPrompt,
      userPrompt: question,
      temperature: 0.1,
      tracking: {
        task: "chat_answer",
        operation: "final_answer_generation",
        requestId,
      },
    });

    return answer || "I could not generate an answer.";
  } catch (error) {
    console.error(`${requestId ? `[${requestId}] ` : ""}Final answer generation failed:`, error);
    throw error;
  }
}

async function answerQuestionWithGraph(question, options = {}) {
  const requestId = options.requestId;
  logWithRequestId(requestId, `Incoming question: ${question}`);

  const keywords = extractKeywords(question);
  if (keywords.length > 0) {
    logWithRequestId(requestId, `Question keywords: ${keywords.join(", ")}`);
  }

  const questionEmbedding = await generateEmbedding(question, {
    task: "chat_answer",
    operation: "question_embedding",
    requestId,
  });
  if (!Array.isArray(questionEmbedding) || questionEmbedding.length === 0) {
    throw new Error("Failed to generate embedding for question.");
  }
  logWithRequestId(
    requestId,
    `Question embedding generated. dimensions=${questionEmbedding.length}`
  );

  const { entryNodes, triples: vectorTriples } = await fetchHybridGraphContext(
    questionEmbedding,
    requestId,
    8
  );

  const { keywordTriples, keywordNodes } = await fetchKeywordGraphContext(keywords, requestId, 80);
  const triples = mergeTriples(vectorTriples, keywordTriples);

  const allEntryNodes = [...entryNodes, ...keywordNodes].slice(0, 12);
  logWithRequestId(
    requestId,
    `Graph extraction returned ${triples.length} triples (vector=${vectorTriples.length}, keyword=${keywordTriples.length}).`
  );

  if (triples.length === 0) {
    const fallbackMessage =
      "I could not find enough information in the uploaded knowledge base to answer this question.";
    return {
      extractedEntity: "",
      graphSummary: "No relevant graph context was retrieved.",
      answer: fallbackMessage,
    };
  }

  const graphSummary = formatHybridContext(allEntryNodes, triples);
  logWithRequestId(requestId, `Graph summary ready. length=${graphSummary.length}`);

  const answer = await generateContextualAnswer(question, graphSummary, requestId, true);

  return {
    extractedEntity: allEntryNodes[0]?.name || "",
    graphSummary,
    answer,
  };
}

module.exports = {
  answerQuestionWithGraph,
};
