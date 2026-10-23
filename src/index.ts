import "dotenv/config";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server";

type ToolCallTrace = {
  name: string;
  status: "running" | "complete";
  summary: string;
};

type AgentResult = {
  response: string;
  toolCalls: ToolCallTrace[];
};

const app = express();
app.use(
  cors({
    origin: (origin, callback) => {
      const isLoopbackOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin ?? "");
      callback(null, !origin || isLoopbackOrigin);
    },
  }),
);
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.resolve(process.cwd(), "public")));

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.post("/api/chat", async (request, response) => {
  const message = parseMessage(request.body?.message);
  if (!message) {
    response.status(400).json({ error: "A non-empty message is required." });
    return;
  }

  const result = await runAgent(message);
  response.json(result);
});

app.post("/api/chat/stream", async (request, response) => {
  const message = parseMessage(request.body?.message);
  if (!message) {
    response.status(400).json({ error: "A non-empty message is required." });
    return;
  }

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();

  try {
    const result = await runAgent(message, (toolCall) => {
      response.write(`data: ${JSON.stringify({ type: "tool", toolCall })}\n\n`);
    });
    response.write(`data: ${JSON.stringify({ type: "complete", ...result })}\n\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "An unexpected server error occurred.";
    response.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
  } finally {
    response.end();
  }
});

const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  const message = error instanceof Error ? error.message : "An unexpected server error occurred.";
  response.status(500).json({ error: message });
};
app.use(errorHandler);

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

app.listen(port, "127.0.0.1", () => {
  console.log(`FlowState running on http://localhost:${port}`);
});

function parseMessage(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function runAgent(
  message: string,
  onToolCall?: (toolCall: ToolCallTrace) => void,
): Promise<AgentResult> {
  const server = createMcpServer();
  const client = new Client({ name: "flowstate-http-agent", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const toolCalls: ToolCallTrace[] = [];

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    onToolCall?.({
      name: "get_git_context",
      status: "running",
      summary: "Inspecting the current repository.",
    });
    const gitResult = await client.callTool({ name: "get_git_context", arguments: {} });
    const gitText = readToolText(gitResult, "get_git_context");
    const gitContext: unknown = JSON.parse(gitText);
    const parsedGitContext = parseGitContext(gitContext);
    const gitTrace: ToolCallTrace = {
      name: "get_git_context",
      status: "complete",
      summary: `Read branch ${parsedGitContext.branch}; git source: ${parsedGitContext.source}.`,
    };
    toolCalls.push(gitTrace);
    onToolCall?.(gitTrace);

    onToolCall?.({
      name: "get_recent_errors",
      status: "running",
      summary: "Reading the demo error and warning log.",
    });
    const errorsResult = await client.callTool({ name: "get_recent_errors", arguments: {} });
    const errorsText = readToolText(errorsResult, "get_recent_errors");
    const errorsPayload: unknown = JSON.parse(errorsText);
    if (
      typeof errorsPayload !== "object" ||
      errorsPayload === null ||
      !("errors" in errorsPayload) ||
      !Array.isArray(errorsPayload.errors) ||
      !errorsPayload.errors.every((entry): entry is string => typeof entry === "string")
    ) {
      throw new Error("get_recent_errors returned an invalid result.");
    }
    const errorsTrace: ToolCallTrace = {
      name: "get_recent_errors",
      status: "complete",
      summary: `Read ${errorsPayload.errors.length} mock log entries.`,
    };
    toolCalls.push(errorsTrace);
    onToolCall?.(errorsTrace);

    onToolCall?.({
      name: "generate_pr_draft",
      status: "running",
      summary: "Sending the collected context to the selected LLM.",
    });
    const draftResult = await client.callTool({
      name: "generate_pr_draft",
      arguments: {
        gitContext: JSON.stringify(parsedGitContext),
        errors: JSON.stringify(errorsPayload.errors),
        request: message.trim(),
      },
    });
    const draftText = readToolText(draftResult, "generate_pr_draft");
    const draftPayload: unknown = JSON.parse(draftText);
    if (
      typeof draftPayload !== "object" ||
      draftPayload === null ||
      !("prDraft" in draftPayload) ||
      typeof draftPayload.prDraft !== "string"
    ) {
      throw new Error("generate_pr_draft returned an invalid result.");
    }
    const draftTrace: ToolCallTrace = {
      name: "generate_pr_draft",
      status: "complete",
      summary: "Generated the pull request draft.",
    };
    toolCalls.push(draftTrace);
    onToolCall?.(draftTrace);

    return { response: draftPayload.prDraft, toolCalls };
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

function parseGitContext(value: unknown): {
  branch: string;
  commits: string;
  staged: string;
  source: "real" | "fallback";
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !("branch" in value) ||
    typeof value.branch !== "string" ||
    !("commits" in value) ||
    typeof value.commits !== "string" ||
    !("staged" in value) ||
    typeof value.staged !== "string" ||
    !("source" in value) ||
    (value.source !== "real" && value.source !== "fallback")
  ) {
    throw new Error("get_git_context returned an invalid result.");
  }
  return {
    branch: value.branch,
    commits: value.commits,
    staged: value.staged,
    source: value.source,
  };
}

function readToolText(result: unknown, toolName: string): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error(`${toolName} failed or returned an invalid result.`);
  }

  const textBlock = result.content.find(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string",
  );
  if ("isError" in result && result.isError === true) {
    throw new Error(`${toolName} failed: ${textBlock?.text ?? "the MCP server returned an error."}`);
  }
  if (!textBlock) {
    throw new Error(`${toolName} returned no text.`);
  }
  return textBlock.text;
}
