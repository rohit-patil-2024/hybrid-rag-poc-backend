const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { testNeo4jConnection } = require("./neo4j");
const uploadRouter = require("./routes/upload");
const chatRouter = require("./routes/chat");
const adminRouter = require("./routes/admin");

dotenv.config();

const app = express();
const PORT = 3001;

const SITE_ACCESS_TOKEN = String(process.env.SITE_ACCESS_TOKEN || "").trim();

function extractToken(req) {
  const authHeader = String(req.headers.authorization || "").trim();
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  const headerToken = String(req.headers["x-access-token"] || "").trim();
  if (headerToken) {
    return headerToken;
  }

  const queryToken = String(req.query?.accessToken || "").trim();
  if (queryToken) {
    return queryToken;
  }

  return "";
}

function isTokenValid(token) {
  return Boolean(SITE_ACCESS_TOKEN) && token === SITE_ACCESS_TOKEN;
}

function requireAccessToken(req, res, next) {
  const providedToken = extractToken(req);
  if (!isTokenValid(providedToken)) {
    return res.status(401).json({ message: "Unauthorized: invalid or missing token." });
  }
  return next();
}

app.use(cors());
app.use(express.json());

app.post("/auth/validate", (req, res) => {
  const token = String(req.body?.token || "").trim();
  if (!SITE_ACCESS_TOKEN) {
    return res.status(500).json({
      message: "SITE_ACCESS_TOKEN is not configured on the backend.",
    });
  }

  if (!isTokenValid(token)) {
    return res.status(401).json({ message: "Invalid token." });
  }

  return res.status(200).json({ message: "Token validated." });
});

app.use("/upload", requireAccessToken, uploadRouter);
app.use("/chat", requireAccessToken, chatRouter);
app.use("/admin", requireAccessToken, adminRouter);

app.get("/health", requireAccessToken, (req, res) => {
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
