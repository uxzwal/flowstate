import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { generatePR } from "./llm";

export type GitContext = {
  branch: string;
  commits: string;
  staged: string;
  source: "real" | "fallback";
};

const sourceDirectory = path.resolve(process.cwd(), "src");
const fallbackPath = path.join(sourceDirectory, "mock_data", "git_fallback.json");
const logsPath = path.join(sourceDirectory, "mock_data", "logs.txt");

export function getGitContext(): GitContext {
  try {
    const options = {
      timeout: 2000,
      encoding: "utf8" as const,
      stdio: "pipe" as const,
    };
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], options).trim();
    const commits = execFileSync("git", ["log", "-3", "--oneline"], options).trim();
    const staged = execFileSync("git", ["diff", "--staged", "--name-only"], options).trim();
    return { branch, commits, staged, source: "real" };
  } catch {
    const fallback: unknown = JSON.parse(readFileSync(fallbackPath, "utf8"));
    if (
      typeof fallback !== "object" ||
      fallback === null ||
      !("branch" in fallback) ||
      typeof fallback.branch !== "string" ||
      !("commits" in fallback) ||
      typeof fallback.commits !== "string" ||
      !("staged" in fallback) ||
      typeof fallback.staged !== "string"
    ) {
      throw new Error("Git fallback data is invalid.");
    }
    return {
      branch: fallback.branch,
      commits: fallback.commits,
      staged: fallback.staged,
      source: "fallback",
    };
  }
}

export function getRecentErrors(): string[] {
  return readFileSync(logsPath, "utf8")
    .split(/\n(?=\[)/)
    .map((entry) => entry.trim())
    .filter((entry) => /\b(ERROR|WARN)\b/.test(entry));
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "flowstate", version: "1.0.0" });

  server.registerTool(
    "get_git_context",
    {
      description: "Get the current repository branch, latest commits, and staged files.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(getGitContext()) }],
    }),
  );

  server.registerTool(
    "get_recent_errors",
    {
      description: "Read and structure the deterministic demo error and warning log entries.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify({ errors: getRecentErrors() }) }],
    }),
  );

  server.registerTool(
    "generate_pr_draft",
    {
      description: "Generate a Markdown pull request description using supplied git and log context.",
      inputSchema: z.object({
        gitContext: z.string().describe("JSON-encoded GitContext returned by get_git_context."),
        errors: z.string().describe("JSON-encoded string array returned by get_recent_errors."),
        request: z.string().min(1).describe("The user's pull request drafting request."),
      }),
    },
    async ({ gitContext, errors, request }) => {
      const parsedContext: unknown = JSON.parse(gitContext);
      const parsedErrors: unknown = JSON.parse(errors);
      if (
        typeof parsedContext !== "object" ||
        parsedContext === null ||
        !("branch" in parsedContext) ||
        typeof parsedContext.branch !== "string" ||
        !("commits" in parsedContext) ||
        typeof parsedContext.commits !== "string" ||
        !("staged" in parsedContext) ||
        typeof parsedContext.staged !== "string" ||
        !("source" in parsedContext) ||
        (parsedContext.source !== "real" && parsedContext.source !== "fallback") ||
        !Array.isArray(parsedErrors) ||
        !parsedErrors.every((entry): entry is string => typeof entry === "string")
      ) {
        throw new Error("Invalid context supplied to generate_pr_draft.");
      }

      const prDraft = await generatePR(parsedContext as GitContext, parsedErrors, request);
      return {
        content: [{ type: "text", text: JSON.stringify({ prDraft }) }],
      };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error("FlowState MCP server failed to start:", error);
    process.exitCode = 1;
  });
}
