const express = require("express");
const cors = require("cors");
const { testNeo4jConnection } = require("./neo4j");
const uploadRouter = require("./routes/upload");
const chatRouter = require("./routes/chat");
const adminRouter = require("./routes/admin");

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

app.use("/upload", uploadRouter);
app.use("/chat", chatRouter);
app.use("/admin", adminRouter);

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "graphrag-backend",
    timestamp: new Date().toISOString(),
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled server error:", err);
  res.status(500).json({ message: "Internal server error" });
});

async function startServer() {
  try {
    await testNeo4jConnection();

    app.listen(PORT, () => {
      console.log(`Backend server is running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server due to Neo4j connection error:", error);
    process.exit(1);
  }
}

startServer();
