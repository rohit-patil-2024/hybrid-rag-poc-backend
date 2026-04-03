const express = require("express");
const { answerQuestionWithGraph } = require("../services/chatService");

const router = express.Router();

function createRequestId() {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

router.post("/", async (req, res) => {
  const requestId = createRequestId();
  try {
    const question = String(req.body?.question || "").trim();
    console.log(`[${requestId}] Chat request received.`);

    if (!question) {
      console.error(`[${requestId}] Chat request rejected: empty question.`);
      return res.status(400).json({
        message: "Question is required.",
      });
    }

    const result = await answerQuestionWithGraph(question, { requestId });
    console.log(
      `[${requestId}] Chat request completed. extractedEntity=${result.extractedEntity || "<empty>"}`
    );

    return res.status(200).json({
      answer: result.answer,
      extractedEntity: result.extractedEntity,
      graphSummary: result.graphSummary,
    });
  } catch (error) {
    console.error(`[${requestId}] Chat endpoint error:`, error);
    return res.status(500).json({
      message: "Failed to process chat request.",
    });
  }
});

module.exports = router;
