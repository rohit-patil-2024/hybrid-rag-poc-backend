const neo4j = require("neo4j-driver");
require("dotenv").config();

const NEO4J_URI = process.env.NEO4J_URI || "bolt://localhost:7687";
const NEO4J_USERNAME = process.env.NEO4J_USERNAME || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "password";

const driver = neo4j.driver(
  NEO4J_URI,
  neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD)
);

async function testNeo4jConnection() {
  try {
    await driver.verifyConnectivity();
    console.log("Neo4j connection successful.");
  } catch (error) {
    console.error("Neo4j connection failed:", error);
    throw error;
  }
}

module.exports = {
  driver,
  testNeo4jConnection,
};
