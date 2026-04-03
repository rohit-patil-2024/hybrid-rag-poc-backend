const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const { chunkText } = require("../utils/textChunker");
const { extractTriplesFromText } = require("../services/openaiExtractor");
const { ingestTriplesToNeo4j } = require("../services/graphIngestion");

const router = express.Router();

function createRequestId() {
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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
    const requestId = createRequestId();
    const startedAt = Date.now();

    if (uploadError) {
      console.error(`[${requestId}] File upload error:`, uploadError);
      return res.status(400).json({ message: uploadError.message });
    }

    if (!req.file) {
      console.error(`[${requestId}] Upload failed: no file attached.`);
      return res.status(400).json({ message: "No PDF file provided." });
    }

    try {
      console.log(
        `[${requestId}] Upload received: name=${req.file.originalname} size=${req.file.size} bytes type=${req.file.mimetype}`
      );
      console.log(`[${requestId}] Parsing PDF text...`);

      const parsed = await pdfParse(req.file.buffer);
      const chunks = chunkText(parsed.text, 1500, 250);
      const allTriples = [];

      console.log(
        `[${requestId}] PDF parsed successfully. textLength=${parsed.text.length} chunks=${chunks.length}`
      );

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const chunkStartedAt = Date.now();
        console.log(
          `[${requestId}] Extracting triples from chunk ${i + 1}/${chunks.length} (chars=${chunk.length})...`
        );

        const triples = await extractTriplesFromText(chunk);
        const enrichedTriples = triples.map((triple) => ({
          ...triple,
          sourceChunk: chunk,
        }));
        allTriples.push(...enrichedTriples);

        console.log(
          `[${requestId}] Chunk ${i + 1}/${chunks.length} done. extracted=${enrichedTriples.length} totalExtracted=${allTriples.length} elapsedMs=${Date.now() - chunkStartedAt}`
        );
      }

      console.log(`[${requestId}] Starting Neo4j ingestion. triples=${allTriples.length}`);
      const ingestedCount = await ingestTriplesToNeo4j(allTriples, ({ processed, total }) => {
        if (total > 0) {
          const pct = Math.round((processed / total) * 100);
          if (processed === total || processed % 25 === 0) {
            console.log(`[${requestId}] Neo4j ingestion progress: ${processed}/${total} (${pct}%)`);
          }
        }
      });

      const totalMs = Date.now() - startedAt;

      console.log(
        `[${requestId}] Upload processing completed. chunks=${chunks.length} extracted=${allTriples.length} ingested=${ingestedCount} elapsedMs=${totalMs}`
      );

      return res.status(200).json({
        message: "PDF uploaded and ingested into graph successfully.",
        chunksProcessed: chunks.length,
        triplesExtracted: allTriples.length,
        triplesIngested: ingestedCount,
      });
    } catch (error) {
      console.error(`[${requestId}] PDF processing error:`, error);
      return res.status(500).json({
        message: "Failed to process PDF.",
      });
    }
  });
});

module.exports = router;
