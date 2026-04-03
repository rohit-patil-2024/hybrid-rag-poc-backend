const { driver } = require("../neo4j");
const { generateEmbeddings } = require("./openaiClient");

function sanitizeRelationshipType(relationship) {
  const normalized = String(relationship || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || "RELATED_TO";
}

async function ingestTriplesToNeo4j(triples, onProgress) {
  if (!Array.isArray(triples) || triples.length === 0) {
    return 0;
  }

  const uniqueEntities = new Set();
  for (const triple of triples) {
    const source = String(triple.source || "").trim();
    const target = String(triple.target || "").trim();
    if (source) {
      uniqueEntities.add(source);
    }
    if (target) {
      uniqueEntities.add(target);
    }
  }

  const entityList = [...uniqueEntities];
  const entityEmbeddings = new Map();

  if (entityList.length > 0) {
    const vectors = await generateEmbeddings(entityList, {
      task: "upload_document",
      operation: "entity_embedding_ingestion",
      meta: {
        entityCount: entityList.length,
      },
    });
    for (let i = 0; i < entityList.length; i += 1) {
      entityEmbeddings.set(entityList[i], vectors[i] || []);
    }
  }

  const session = driver.session();

  try {
    await session.run(
      `
        CREATE VECTOR INDEX entity_embedding_index IF NOT EXISTS
        FOR (e:Entity) ON (e.embedding)
        OPTIONS {
          indexConfig: {
            \`vector.dimensions\`: 1536,
            \`vector.similarity_function\`: 'cosine'
          }
        }
      `
    );

    await session.executeWrite(async (tx) => {
      let processed = 0;

      for (const triple of triples) {
        const source = String(triple.source || "").trim();
        const target = String(triple.target || "").trim();
        const relationshipType = sanitizeRelationshipType(triple.relationship);
        const sourceEmbedding = entityEmbeddings.get(source) || [];
        const targetEmbedding = entityEmbeddings.get(target) || [];
        const sourceChunk = String(triple.sourceChunk || "").trim();

        if (!source || !target) {
          processed += 1;
          if (typeof onProgress === "function") {
            onProgress({ processed, total: triples.length });
          }
          continue;
        }

        const query = `
          MERGE (s:Entity {name: $source})
          ON CREATE SET s.createdAt = datetime()
          SET s.embedding = CASE WHEN size($sourceEmbedding) > 0 THEN $sourceEmbedding ELSE s.embedding END,
              s.lastSeenAt = datetime(),
              s.sourceTextChunk = CASE
                WHEN $sourceChunk = '' THEN s.sourceTextChunk
                ELSE $sourceChunk
              END
          MERGE (t:Entity {name: $target})
          ON CREATE SET t.createdAt = datetime()
          SET t.embedding = CASE WHEN size($targetEmbedding) > 0 THEN $targetEmbedding ELSE t.embedding END,
              t.lastSeenAt = datetime(),
              t.sourceTextChunk = CASE
                WHEN $sourceChunk = '' THEN t.sourceTextChunk
                ELSE $sourceChunk
              END
          MERGE (s)-[r:${relationshipType}]->(t)
          ON CREATE SET r.createdAt = datetime(),
                        r.sourceTextChunk = $sourceChunk,
                        r.evidenceChunks = CASE WHEN $sourceChunk = '' THEN [] ELSE [$sourceChunk] END
          SET r.lastSeenAt = datetime(),
              r.sourceTextChunk = CASE
                WHEN $sourceChunk = '' THEN r.sourceTextChunk
                ELSE $sourceChunk
              END,
              r.evidenceChunks = CASE
                WHEN $sourceChunk = '' THEN coalesce(r.evidenceChunks, [])
                WHEN any(existing IN coalesce(r.evidenceChunks, []) WHERE existing = $sourceChunk)
                  THEN coalesce(r.evidenceChunks, [])
                ELSE coalesce(r.evidenceChunks, []) + $sourceChunk
              END
        `;

        await tx.run(query, {
          source,
          target,
          sourceEmbedding,
          targetEmbedding,
          sourceChunk,
        });

        processed += 1;
        if (typeof onProgress === "function") {
          onProgress({ processed, total: triples.length });
        }
      }
    });

    return triples.length;
  } catch (error) {
    console.error("Neo4j ingestion failed:", error);
    throw error;
  } finally {
    await session.close();
  }
}

module.exports = {
  ingestTriplesToNeo4j,
};
