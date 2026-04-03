const express = require("express");
const { driver } = require("../neo4j");
const { buildSnapshot, clearTokenUsage } = require("../services/tokenUsageTracker");

const router = express.Router();

router.get("/token-usage", (req, res) => {
  try {
    return res.status(200).json(buildSnapshot());
  } catch (error) {
    console.error("[token-usage] Failed to build token usage snapshot:", error);
    return res.status(500).json({
      message: "Failed to fetch token usage.",
    });
  }
});

router.post("/token-usage/reset", (req, res) => {
  clearTokenUsage();
  return res.status(200).json({
    message: "Token usage tracking has been reset.",
  });
});

router.get("/graph-status", async (req, res) => {
  const requestId = `status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session = driver.session();

  try {
    const summaryResult = await session.executeRead((tx) =>
      tx.run(
        `
          MATCH (n)
          OPTIONAL MATCH (n)-[r]-()
          RETURN count(DISTINCT n) AS nodeCount, count(DISTINCT r) AS relationshipCount
        `
      )
    );

    const vectorCoverageResult = await session.executeRead((tx) =>
      tx.run(
        `
          MATCH (e:Entity)
          WITH e,
               CASE WHEN e.embedding IS NOT NULL AND size(e.embedding) > 0 THEN 1 ELSE 0 END AS hasEmbedding,
               CASE WHEN coalesce(trim(e.sourceTextChunk), '') <> '' THEN 1 ELSE 0 END AS hasSourceChunk
          RETURN count(e) AS entityCount,
                 sum(hasEmbedding) AS vectorizedNodeCount,
                 sum(1 - hasEmbedding) AS nonVectorizedNodeCount,
                 sum(hasSourceChunk) AS nodesWithSourceChunk,
                 sum(1 - hasSourceChunk) AS nodesWithoutSourceChunk
        `
      )
    );

    const relationshipCoverageResult = await session.executeRead((tx) =>
      tx.run(
        `
          MATCH ()-[r]-()
          WITH r,
               CASE
                 WHEN (r.evidenceChunks IS NOT NULL AND size(r.evidenceChunks) > 0)
                      OR coalesce(trim(r.sourceTextChunk), '') <> ''
                   THEN 1
                 ELSE 0
               END AS hasEvidence
          RETURN count(r) AS totalRelationships,
                 sum(hasEvidence) AS relationshipsWithEvidence,
                 sum(1 - hasEvidence) AS relationshipsWithoutEvidence
        `
      )
    );

    const indexResult = await session.executeRead((tx) =>
      tx.run(
        `
          SHOW VECTOR INDEXES
          YIELD name, state, type
          WHERE name = 'entity_embedding_index'
          RETURN name, state, type
          LIMIT 1
        `
      )
    );

    const sampleVectorizedNodesResult = await session.executeRead((tx) =>
      tx.run(
        `
          MATCH (e:Entity)
          WHERE e.embedding IS NOT NULL AND size(e.embedding) > 0
          RETURN e.name AS name, size(e.embedding) AS embeddingDimensions
          ORDER BY e.lastSeenAt DESC, e.name ASC
          LIMIT 10
        `
      )
    );

    const sampleNonVectorizedNodesResult = await session.executeRead((tx) =>
      tx.run(
        `
          MATCH (e:Entity)
          WHERE e.embedding IS NULL OR size(e.embedding) = 0
          RETURN e.name AS name
          ORDER BY e.lastSeenAt DESC, e.name ASC
          LIMIT 10
        `
      )
    );

    const sampleRelationshipsWithEvidenceResult = await session.executeRead((tx) =>
      tx.run(
        `
          MATCH (s:Entity)-[r]->(t:Entity)
          WHERE (r.evidenceChunks IS NOT NULL AND size(r.evidenceChunks) > 0)
             OR coalesce(trim(r.sourceTextChunk), '') <> ''
          RETURN s.name AS source, type(r) AS relationship, t.name AS target,
                 coalesce(r.sourceTextChunk, r.evidenceChunks[0], '') AS evidenceSnippet
          ORDER BY r.lastSeenAt DESC
          LIMIT 10
        `
      )
    );

    const sampleRelationshipsWithoutEvidenceResult = await session.executeRead((tx) =>
      tx.run(
        `
          MATCH (s:Entity)-[r]->(t:Entity)
          WHERE (r.evidenceChunks IS NULL OR size(r.evidenceChunks) = 0)
            AND coalesce(trim(r.sourceTextChunk), '') = ''
          RETURN s.name AS source, type(r) AS relationship, t.name AS target
          ORDER BY r.lastSeenAt DESC
          LIMIT 10
        `
      )
    );

    const nodeCount = Number(summaryResult.records?.[0]?.get("nodeCount") || 0);
    const relationshipCount = Number(
      summaryResult.records?.[0]?.get("relationshipCount") || 0
    );

    const entityCount = Number(vectorCoverageResult.records?.[0]?.get("entityCount") || 0);
    const vectorizedNodeCount = Number(
      vectorCoverageResult.records?.[0]?.get("vectorizedNodeCount") || 0
    );
    const nonVectorizedNodeCount = Number(
      vectorCoverageResult.records?.[0]?.get("nonVectorizedNodeCount") || 0
    );
    const nodesWithSourceChunk = Number(
      vectorCoverageResult.records?.[0]?.get("nodesWithSourceChunk") || 0
    );
    const nodesWithoutSourceChunk = Number(
      vectorCoverageResult.records?.[0]?.get("nodesWithoutSourceChunk") || 0
    );

    const relationshipsWithEvidence = Number(
      relationshipCoverageResult.records?.[0]?.get("relationshipsWithEvidence") || 0
    );
    const relationshipsWithoutEvidence = Number(
      relationshipCoverageResult.records?.[0]?.get("relationshipsWithoutEvidence") || 0
    );

    const indexRecord = indexResult.records?.[0];

    const vectorizedNodes = sampleVectorizedNodesResult.records.map((record) => ({
      name: String(record.get("name") || ""),
      embeddingDimensions: Number(record.get("embeddingDimensions") || 0),
    }));

    const nonVectorizedNodes = sampleNonVectorizedNodesResult.records.map((record) => ({
      name: String(record.get("name") || ""),
    }));

    const relationshipsWithEvidenceSample = sampleRelationshipsWithEvidenceResult.records.map(
      (record) => ({
        source: String(record.get("source") || ""),
        relationship: String(record.get("relationship") || ""),
        target: String(record.get("target") || ""),
        evidenceSnippet: String(record.get("evidenceSnippet") || "").slice(0, 200),
      })
    );

    const relationshipsWithoutEvidenceSample =
      sampleRelationshipsWithoutEvidenceResult.records.map((record) => ({
        source: String(record.get("source") || ""),
        relationship: String(record.get("relationship") || ""),
        target: String(record.get("target") || ""),
      }));

    console.log(
      `[${requestId}] Graph status fetched. nodes=${nodeCount} relationships=${relationshipCount} vectorizedNodes=${vectorizedNodeCount} nonVectorizedNodes=${nonVectorizedNodeCount}`
    );

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      totals: {
        nodeCount,
        relationshipCount,
        entityCount,
      },
      vectorStatus: {
        vectorizedNodeCount,
        nonVectorizedNodeCount,
        nodesWithSourceChunk,
        nodesWithoutSourceChunk,
      },
      relationshipStatus: {
        relationshipsWithEvidence,
        relationshipsWithoutEvidence,
      },
      indexStatus: indexRecord
        ? {
            name: String(indexRecord.get("name") || ""),
            state: String(indexRecord.get("state") || ""),
            type: String(indexRecord.get("type") || ""),
          }
        : {
            name: "entity_embedding_index",
            state: "MISSING",
            type: "VECTOR",
          },
      samples: {
        vectorizedNodes,
        nonVectorizedNodes,
        relationshipsWithEvidence: relationshipsWithEvidenceSample,
        relationshipsWithoutEvidence: relationshipsWithoutEvidenceSample,
      },
    });
  } catch (error) {
    console.error(`[${requestId}] Failed to fetch graph status:`, error);
    return res.status(500).json({
      message: "Failed to fetch graph status.",
    });
  } finally {
    await session.close();
  }
});

router.post("/clear-graph", async (req, res) => {
  const requestId = `clear-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const session = driver.session();
  try {
    const countResult = await session.executeRead((tx) =>
      tx.run(
        `
          MATCH (n)
          OPTIONAL MATCH (n)-[r]-()
          RETURN count(DISTINCT n) AS nodeCount, count(DISTINCT r) AS relationshipCount
        `
      )
    );

    const nodeCount = Number(countResult.records?.[0]?.get("nodeCount") || 0);
    const relationshipCount = Number(
      countResult.records?.[0]?.get("relationshipCount") || 0
    );

    await session.executeWrite((tx) => tx.run("MATCH (n) DETACH DELETE n"));

    console.log(
      `[${requestId}] Knowledge graph cleared. deletedNodes=${nodeCount} deletedRelationships=${relationshipCount}`
    );

    return res.status(200).json({
      message: "Knowledge graph cleared successfully.",
      deletedNodes: nodeCount,
      deletedRelationships: relationshipCount,
    });
  } catch (error) {
    console.error(`[${requestId}] Failed to clear knowledge graph:`, error);
    return res.status(500).json({
      message: "Failed to clear knowledge graph.",
    });
  } finally {
    await session.close();
  }
});

module.exports = router;
