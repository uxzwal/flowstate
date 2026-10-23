import "dotenv/config";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const systemPrompt =
  "You are FlowState, an expert DevOps engineer. Use only the supplied git and error context; never invent code changes or claim tests passed without evidence. Return a concise Markdown pull request description with exactly these sections: Summary, Technical Changes, Testing Notes.";

type GitContext = {
  branch: string;
  commits: string;
  staged: string;
  source: "real" | "fallback";
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function callBedrock(prompt: string): Promise<string> {
  const client = new BedrockRuntimeClient({
    region: requiredEnv("AWS_REGION"),
  });
  const command = new InvokeModelCommand({
    modelId: requiredEnv("BEDROCK_MODEL_ID"),
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    }),
  });

  const response = await client.send(command);
  if (!response.body) {
    throw new Error("Bedrock returned an empty response body.");
  }

  const payload: unknown = JSON.parse(new TextDecoder().decode(response.body));
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("content" in payload) ||
    !Array.isArray(payload.content)
  ) {
    throw new Error("Bedrock returned an unexpected response format.");
  }

  const textBlock = payload.content.find(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string",
  );
  if (!textBlock) {
    throw new Error("Bedrock response did not contain text.");
  }
  return textBlock.text;
}

async function callOllama(prompt: string): Promise<string> {
  const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL ?? "llama3",
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama request failed (${response.status}): ${await response.text()}`);
  }

  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("message" in payload) ||
    typeof payload.message !== "object" ||
    payload.message === null ||
    !("content" in payload.message) ||
    typeof payload.message.content !== "string"
  ) {
    throw new Error("Ollama returned an unexpected response format.");
  }
  return payload.message.content;
}

export async function generatePR(
  gitContext: GitContext,
  errors: string[],
  request: string,
): Promise<string> {
  const prompt = [
    `User request: ${request}`,
    `Git context (source: ${gitContext.source}):`,
    JSON.stringify(gitContext, null, 2),
    "Recent error and warning log entries:",
    JSON.stringify(errors, null, 2),
    "Do not state that an issue was fixed or tests passed unless the supplied context proves it.",
  ].join("\n\n");

  switch ((process.env.LLM_PROVIDER ?? "bedrock").toLowerCase()) {
    case "bedrock":
      return callBedrock(prompt);
    case "ollama":
      return callOllama(prompt);
    default:
      throw new Error('LLM_PROVIDER must be either "bedrock" or "ollama".');
  }
}
