function chunkText(rawText, chunkSize = 1500, chunkOverlap = 250) {
  if (!rawText || typeof rawText !== "string") {
    return [];
  }

  if (chunkSize <= 0) {
    throw new Error("chunkSize must be greater than 0.");
  }

  if (chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new Error("chunkOverlap must be >= 0 and < chunkSize.");
  }

  const cleanText = rawText.replace(/\s+/g, " ").trim();
  if (!cleanText) {
    return [];
  }

  const chunks = [];
  let start = 0;

  while (start < cleanText.length) {
    let end = Math.min(start + chunkSize, cleanText.length);

    if (end < cleanText.length) {
      const lastSpace = cleanText.lastIndexOf(" ", end);
      if (lastSpace > start + Math.floor(chunkSize * 0.6)) {
        end = lastSpace;
      }
    }

    const chunk = cleanText.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= cleanText.length) {
      break;
    }

    start = Math.max(0, end - chunkOverlap);
  }

  return chunks;
}

module.exports = {
  chunkText,
};
