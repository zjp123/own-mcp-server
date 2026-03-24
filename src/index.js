const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");
const { createMcpServer } = require("./mcpServer");

const envPath = process.env.ENV_FILE
  ? path.resolve(process.cwd(), process.env.ENV_FILE)
  : fs.existsSync(path.resolve(process.cwd(), ".env"))
    ? path.resolve(process.cwd(), ".env")
    : path.resolve(process.cwd(), ".env.example");
dotenv.config({ path: envPath });

const app = createMcpExpressApp();
const PORT = Number(process.env.PORT || 8080);
const mcpRoute = process.env.MCP_ROUTE || "/mcp";
const authToken = String(process.env.MCP_AUTH_TOKEN || "").trim();
const sessions = new Map();

function unauthorized(res) {
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized" },
    id: null,
  });
}

function authMiddleware(req, res, next) {
  if (!authToken) {
    next();
    return;
  }
  const authHeader = String(req.headers.authorization || "");
  if (!authHeader.startsWith("Bearer ")) {
    unauthorized(res);
    return;
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token || token !== authToken) {
    unauthorized(res);
    return;
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "own-mcpserver",
    route: mcpRoute,
  });
});

app.post(mcpRoute, authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  try {
    if (sessionId && sessions.has(sessionId)) {
      const current = sessions.get(sessionId);
      await current.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (initializedSessionId) => {
          sessions.set(initializedSessionId, { transport, server });
        },
      });

      transport.onclose = async () => {
        const sid = transport.sessionId;
        if (sid && sessions.has(sid)) {
          sessions.delete(sid);
        }
        await server.close();
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: invalid session or initialize payload" },
      id: null,
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get(mcpRoute, authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  const current = sessions.get(sessionId);
  await current.transport.handleRequest(req, res);
});

app.delete(mcpRoute, authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  const current = sessions.get(sessionId);
  await current.transport.handleRequest(req, res);
});

const server = app.listen(PORT, () => {
  console.log(`MCP server listening on http://localhost:${PORT}${mcpRoute}`);
});

async function shutdown() {
  for (const [sid, current] of sessions.entries()) {
    sessions.delete(sid);
    await current.transport.close();
    await current.server.close();
  }
  server.close(() => process.exit(0));
}

// Ctrl + C
process.on("SIGINT", shutdown);
// kill
process.on("SIGTERM", shutdown);
