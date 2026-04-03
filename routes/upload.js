const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const { chunkText } = require("../utils/textChunker");
const { extractTriplesFromText } = require("../services/openaiExtractor");
const { ingestTriplesToNeo4j } = require("../services/graphIngestion");

const router = express.Router();
const uploadProgressClients = new Map();

function createRequestId() {
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emitUploadProgress(requestId, event) {
  const clients = uploadProgressClients.get(requestId);
  if (!clients || clients.size === 0) {
    return;
  }

  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...event,
  });

  for (const res of clients) {
    res.write(`data: ${payload}\n\n`);
  }
}

router.get("/progress/:requestId", (req, res) => {
  const requestId = String(req.params.requestId || "").trim();
  if (!requestId) {
    return res.status(400).json({ message: "requestId is required." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  if (!uploadProgressClients.has(requestId)) {
    uploadProgressClients.set(requestId, new Set());
  }

  const clients = uploadProgressClients.get(requestId);
  clients.add(res);

  res.write(`data: ${JSON.stringify({ type: "connected", message: "Progress stream connected." })}\n\n`);

  req.on("close", () => {
    clients.delete(res);
    if (clients.size === 0) {
      uploadProgressClients.delete(requestId);
    }
  });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Only PDF files are allowed."));
    }
    cb(null, true);
  },
});

router.post("/", (req, res) => {
  upload.single("file")(req, res, async (uploadError) => {
    const requestId = String(req.query.requestId || "").trim() || createRequestId();
    const startedAt = Date.now();

    emitUploadProgress(requestId, {
      type: "init",
      message: "Upload request accepted.",
      requestId,
    });

    if (uploadError) {
      console.error(`[${requestId}] File upload error:`, uploadError);
      emitUploadProgress(requestId, {
        type: "error",
        message: `Upload error: ${uploadError.message}`,
      });
      return res.status(400).json({ message: uploadError.message });
    }

    if (!req.file) {
      console.error(`[${requestId}] Upload failed: no file attached.`);
      emitUploadProgress(requestId, {
        type: "error",
        message: "Upload failed: no PDF file provided.",
      });
      return res.status(400).json({ message: "No PDF file provided." });
    }

    try {
      console.log(
        `[${requestId}] Upload received: name=${req.file.originalname} size=${req.file.size} bytes type=${req.file.mimetype}`
      );
      console.log(`[${requestId}] Parsing PDF text...`);
      emitUploadProgress(requestId, {
        type: "parsing",
        message: `Parsing PDF: ${req.file.originalname}`,
      });

      const parsed = await pdfParse(req.file.buffer);
      const chunks = chunkText(parsed.text, 1500, 250);
      const allTriples = [];

      emitUploadProgress(requestId, {
        type: "chunking",
        message: `Chunking complete. Total chunks: ${chunks.length}`,
        chunks: chunks.length,
      });

      console.log(
        `[${requestId}] PDF parsed successfully. textLength=${parsed.text.length} chunks=${chunks.length}`
      );

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const chunkStartedAt = Date.now();
        console.log(
          `[${requestId}] Extracting triples from chunk ${i + 1}/${chunks.length} (chars=${chunk.length})...`
        );
        emitUploadProgress(requestId, {
          type: "extracting",
          message: `Extracting relationships from chunk ${i + 1}/${chunks.length}...`,
          chunkIndex: i + 1,
          chunkTotal: chunks.length,
        });

        const triples = await extractTriplesFromText(chunk);
        const enrichedTriples = triples.map((triple) => ({
          ...triple,
          sourceChunk: chunk,
        }));
        allTriples.push(...enrichedTriples);

        emitUploadProgress(requestId, {
          type: "extracting",
          message: `Chunk ${i + 1}/${chunks.length} extracted ${enrichedTriples.length} triples (total: ${allTriples.length}).`,
          chunkIndex: i + 1,
          chunkTotal: chunks.length,
          extracted: enrichedTriples.length,
          totalExtracted: allTriples.length,
        });

        console.log(
          `[${requestId}] Chunk ${i + 1}/${chunks.length} done. extracted=${enrichedTriples.length} totalExtracted=${allTriples.length} elapsedMs=${Date.now() - chunkStartedAt}`
        );
      }

      console.log(`[${requestId}] Starting Neo4j ingestion. triples=${allTriples.length}`);
      emitUploadProgress(requestId, {
        type: "ingestion",
        message: `Starting graph ingestion for ${allTriples.length} triples...`,
      });
      const ingestedCount = await ingestTriplesToNeo4j(allTriples, ({ processed, total }) => {
        if (total > 0) {
          const pct = Math.round((processed / total) * 100);
          emitUploadProgress(requestId, {
            type: "ingestion",
            message: `Graph ingestion progress: ${processed}/${total} (${pct}%).`,
            processed,
            total,
            percent: pct,
          });
          if (processed === total || processed % 25 === 0) {
            console.log(`[${requestId}] Neo4j ingestion progress: ${processed}/${total} (${pct}%)`);
          }
        }
      });

      const totalMs = Date.now() - startedAt;

      console.log(
        `[${requestId}] Upload processing completed. chunks=${chunks.length} extracted=${allTriples.length} ingested=${ingestedCount} elapsedMs=${totalMs}`
      );
      emitUploadProgress(requestId, {
        type: "completed",
        message: `Completed. chunks=${chunks.length}, extracted=${allTriples.length}, ingested=${ingestedCount}, elapsed=${totalMs}ms.`,
        chunks: chunks.length,
        extracted: allTriples.length,
        ingested: ingestedCount,
      });

      return res.status(200).json({
        message: "PDF uploaded and ingested into graph successfully.",
        chunksProcessed: chunks.length,
        triplesExtracted: allTriples.length,
        triplesIngested: ingestedCount,
      });
    } catch (error) {
      console.error(`[${requestId}] PDF processing error:`, error);
      emitUploadProgress(requestId, {
        type: "error",
        message: `Processing failed: ${error.message || "Unknown error"}`,
      });
      return res.status(500).json({
        message: "Failed to process PDF.",
      });
    }
  });
});

module.exports = router;
