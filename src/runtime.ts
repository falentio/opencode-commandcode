import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  buildAlphaRequest,
  collectOpenAISseAsJson,
  inspectAndWrapAlphaResponse,
  makeUUID,
  type OpenAIChatRequest,
  type OpenAIMessage,
  type OpenAITool,
  type OpenAIToolCall,
  type UUID,
} from "./alpha-wire.js";
import {
  makeModelId,
  resolveCommandCodeAlphaURL,
  type CommandCodeCatalog,
  type FetchLike,
} from "./catalog.js";
import { lookupStaticModelMetadata, type StaticModelMetadataLookup } from "./model-metadata.js";

export const COMMAND_CODE_API_KEY_ENV = "COMMANDCODE_API_KEY";

export type CommandCodeRuntimeOptions = {
  apiKey?: string;
  fetch?: FetchLike;
  metadataLookup?: StaticModelMetadataLookup;
  upstreamURL?: string;
  env?: Record<string, string | undefined>;
  resolveApiKey?: () => Promise<string | undefined>;
};

// Mirrored Command Code CLI version our wire matches.
// The gateway rejects older versions, so this must track the CLI release
// from /tmp/opencode/cmd-llm-api.verbose.md, not this package's version.
const MIRRORED_COMMAND_CODE_VERSION = "1.54.1";

// The gateway validates `params.max_tokens` with a hard `<= 200000` bound.
// Probed live: 200001 is rejected on every model with
// `Too big: expected number to be <=200000 at "params.max_tokens"`, while
// 200000 is accepted even on a model whose own declared output limit is
// 32768, so the bound is a field validation and not a per-model limit.
// Without the clamp, every catalog model whose output limit exceeds the bound
// fails every request.
export const COMMAND_CODE_MAX_OUTPUT_TOKENS = 200000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function decodeToolCall(value: unknown): OpenAIToolCall | undefined {
  if (!isRecord(value)) return undefined;
  const functionValue = readObject(value.function);
  if (value.id !== undefined && typeof value.id !== "string") return undefined;
  if (value.type !== undefined && value.type !== "function") return undefined;
  if (
    functionValue &&
    "name" in functionValue &&
    functionValue.name !== undefined &&
    typeof functionValue.name !== "string"
  )
    return undefined;
  const id = typeof value.id === "string" ? value.id : undefined;
  const type = value.type === "function" ? "function" : undefined;
  const name =
    functionValue && typeof functionValue.name === "string" ? functionValue.name : undefined;
  const argumentsValue =
    functionValue && "arguments" in functionValue ? functionValue.arguments : undefined;
  return {
    ...(id === undefined ? {} : { id }),
    ...(type === undefined ? {} : { type }),
    ...(functionValue === undefined
      ? {}
      : {
          function: {
            ...(name === undefined ? {} : { name }),
            ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
          },
        }),
  };
}

function decodeMessage(value: unknown): OpenAIMessage | undefined {
  if (!isRecord(value)) return undefined;
  const role = value.role;
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool")
    return undefined;
  if (value.tool_call_id !== undefined && typeof value.tool_call_id !== "string") return undefined;
  if (value.name !== undefined && typeof value.name !== "string") return undefined;

  let toolCalls: OpenAIToolCall[] | undefined;
  if (value.tool_calls !== undefined) {
    if (!Array.isArray(value.tool_calls)) return undefined;
    toolCalls = [];
    for (const toolCall of value.tool_calls) {
      const decoded = decodeToolCall(toolCall);
      if (!decoded) return undefined;
      toolCalls.push(decoded);
    }
  }

  const reasoningContent = value.reasoning_content ?? value.reasoning;

  return {
    role,
    content: value.content,
    ...(reasoningContent === undefined ? {} : { reasoning_content: reasoningContent }),
    ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
    ...(value.tool_call_id === undefined ? {} : { tool_call_id: value.tool_call_id }),
    ...(value.name === undefined ? {} : { name: value.name }),
  };
}

function decodeTool(value: unknown): OpenAITool | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type !== undefined && typeof value.type !== "string") return undefined;
  if (value.name !== undefined && typeof value.name !== "string") return undefined;
  if (value.description !== undefined && typeof value.description !== "string") return undefined;

  const functionValue = readObject(value.function);
  if (functionValue && functionValue.name !== undefined && typeof functionValue.name !== "string")
    return undefined;
  if (
    functionValue &&
    functionValue.description !== undefined &&
    typeof functionValue.description !== "string"
  )
    return undefined;
  if (
    functionValue &&
    functionValue.parameters !== undefined &&
    !readObject(functionValue.parameters)
  )
    return undefined;
  if (value.input_schema !== undefined && !readObject(value.input_schema)) return undefined;
  if (value.parameters !== undefined && !readObject(value.parameters)) return undefined;

  const type = typeof value.type === "string" ? value.type : undefined;
  const name = typeof value.name === "string" ? value.name : undefined;
  const description = typeof value.description === "string" ? value.description : undefined;
  const functionName =
    functionValue && typeof functionValue.name === "string" ? functionValue.name : undefined;
  const functionDescription =
    functionValue && typeof functionValue.description === "string"
      ? functionValue.description
      : undefined;
  const functionParameters = functionValue ? readObject(functionValue.parameters) : undefined;
  const inputSchema = readObject(value.input_schema);
  const parameters = readObject(value.parameters);

  return {
    ...(type === undefined ? {} : { type }),
    ...(functionValue === undefined
      ? {}
      : {
          function: {
            ...(functionName === undefined ? {} : { name: functionName }),
            ...(functionDescription === undefined ? {} : { description: functionDescription }),
            ...(functionParameters === undefined ? {} : { parameters: functionParameters }),
          },
        }),
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(inputSchema === undefined ? {} : { input_schema: inputSchema }),
    ...(parameters === undefined ? {} : { parameters }),
  };
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function decodeOpenAIChatRequest(payload: unknown): OpenAIChatRequest {
  if (!isRecord(payload) || typeof payload.model !== "string" || !Array.isArray(payload.messages)) {
    throw new Error("CommandCode received an invalid OpenAI request body");
  }

  const messages: OpenAIMessage[] = [];
  for (const value of payload.messages) {
    const message = decodeMessage(value);
    if (!message) throw new Error("CommandCode received an invalid OpenAI message");
    messages.push(message);
  }

  let tools: OpenAITool[] | undefined;
  if (payload.tools !== undefined) {
    if (!Array.isArray(payload.tools))
      throw new Error("CommandCode received an invalid OpenAI tools value");
    tools = [];
    for (const value of payload.tools) {
      const tool = decodeTool(value);
      if (!tool) throw new Error("CommandCode received an invalid OpenAI tool");
      tools.push(tool);
    }
  }

  const stream = payload.stream;
  if (stream !== undefined && typeof stream !== "boolean")
    throw new Error("CommandCode received an invalid stream value");

  // opencode's bundled OpenAI-compatible route picks the max-tokens field from
  // the provider/baseURL, and this proxy is neither OpenAI nor a known host, so
  // it sends `max_completion_tokens`. The alpha wire only accepts `max_tokens`.
  const maxTokens = optionalNumber(payload, "max_tokens") ?? optionalNumber(payload, "max_completion_tokens");

  return {
    model: payload.model,
    messages,
    ...(stream === undefined ? {} : { stream }),
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...(optionalNumber(payload, "max_output_tokens") === undefined
      ? {}
      : { max_output_tokens: optionalNumber(payload, "max_output_tokens") }),
    ...(optionalNumber(payload, "temperature") === undefined
      ? {}
      : { temperature: optionalNumber(payload, "temperature") }),
    ...(optionalNumber(payload, "top_p") === undefined
      ? {}
      : { top_p: optionalNumber(payload, "top_p") }),
    ...(typeof payload.reasoning_effort === "string" && payload.reasoning_effort.length > 0
      ? { reasoning_effort: payload.reasoning_effort }
      : {}),
    ...(tools === undefined ? {} : { tools }),
  };
}

function newRequestUUID(): UUID {
  return makeUUID(randomUUID());
}

export function resolveCommandCodeApiKey(options: CommandCodeRuntimeOptions): string | undefined {
  if (options.apiKey) return options.apiKey;
  const env = options.env ?? process.env;
  const fromEnv = env[COMMAND_CODE_API_KEY_ENV] ?? env.COMMAND_CODE_API_KEY;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

async function currentApiKey(options: CommandCodeRuntimeOptions): Promise<string | undefined> {
  const resolved = options.resolveApiKey ? await options.resolveApiKey() : undefined;
  return resolved && resolved.length > 0 ? resolved : resolveCommandCodeApiKey(options);
}

// The upstream URL is overridable so the plugin can be exercised against a
// local stand-in for the CommandCode gateway without a real API key.
function resolveUpstreamURL(options: CommandCodeRuntimeOptions): string {
  if (options.upstreamURL) return options.upstreamURL;
  return resolveCommandCodeAlphaURL(options.env ?? process.env);
}

export async function translateChatCompletion(
  payload: unknown,
  options: CommandCodeRuntimeOptions = {},
  signal?: AbortSignal,
): Promise<Response> {
  const fetcher = options.fetch ?? fetch;
  const metadataLookup = options.metadataLookup ?? lookupStaticModelMetadata;
  const upstreamURL = resolveUpstreamURL(options);
  const body = decodeOpenAIChatRequest(payload);
  const modelId = makeModelId(body.model);
  const staticMetadata = metadataLookup(modelId);
  const request = buildAlphaRequest(
    body,
    () => new Date(),
    newRequestUUID,
    staticMetadata?.outputLimit,
    staticMetadata?.vision,
  );
  request.params.max_tokens = Math.min(request.params.max_tokens, COMMAND_CODE_MAX_OUTPUT_TOKENS);
  const sessionId = newRequestUUID();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "cli",
    "x-command-code-version": MIRRORED_COMMAND_CODE_VERSION,
    "x-cli-environment": "production",
    "x-session-id": sessionId,
    Accept: "text/event-stream",
  };
  const apiKey = await currentApiKey(options);
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetcher(upstreamURL, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal,
  });
  const wrapped = await inspectAndWrapAlphaResponse(response, request.model);
  return body.stream === true ? wrapped : collectOpenAISseAsJson(wrapped, request.model);
}

export type CommandCodeProxyOptions = CommandCodeRuntimeOptions & {
  catalog?: CommandCodeCatalog;
  host?: string;
};

export type CommandCodeProxy = {
  readonly port: number;
  readonly baseURL: string;
  close: () => Promise<void>;
};

function writeError(response: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ error: { message, type: "invalid_request_error" } });
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

// `status` is unusable once headers are out, so a mid-stream failure has to be
// reported inside the stream. opencode's SSE parser reads `error.message` off
// a frame and fails the turn with it, which is the streaming equivalent of the
// 502 the non-streaming path returns.
function writeStreamError(response: ServerResponse, error: unknown): void {
  if (response.writableEnded) return;
  const cause = error instanceof Error ? error.message : "unknown error";
  const body = JSON.stringify({
    error: { message: `CommandCode upstream stream failed: ${cause}`, type: "server_error" },
  });
  try {
    response.write(`data: ${body}\n\n`);
    response.write("data: [DONE]\n\n");
  } catch {
    // The client is already gone; there is no one left to report to.
  }
}

function readIncomingBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function writeWebResponse(response: ServerResponse, upstream: Response): Promise<void> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    headers[key] = value;
  });
  response.writeHead(upstream.status, headers);
  if (!upstream.body) {
    response.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      response.write(Buffer.from(next.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    writeStreamError(response, error);
  } finally {
    response.end();
  }
}

function handleModels(response: ServerResponse, catalog: CommandCodeCatalog | undefined): void {
  const data = (catalog ?? []).map((item) => ({
    id: item.id,
    object: "model",
    created: item.created ?? 0,
    owned_by: "command-code",
    name: item.name,
    context_length: item.contextLength,
  }));
  const body = JSON.stringify({ object: "list", data });
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

export async function startCommandCodeProxy(
  options: CommandCodeProxyOptions = {},
): Promise<CommandCodeProxy> {
  const host = options.host ?? "127.0.0.1";
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    const path = url.pathname.replace(/\/+$/, "");

    if (request.method === "GET" && (path === "/v1/models" || path === "/models")) {
      handleModels(response, options.catalog);
      return;
    }

    if (request.method !== "POST" || path !== "/v1/chat/completions") {
      writeError(response, 404, `CommandCode proxy has no route for ${request.method} ${path}`);
      return;
    }

    // Registering this before the body read matters: the request stream has
    // already ended by the time the body is read, so a `request.on("close")`
    // listener never fires. A request's "close" also fires on normal
    // completion, so the response's "close" is the signal that actually means
    // "the client went away before we finished".
    const abort = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) abort.abort();
    });

    const raw = await readIncomingBody(request);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      writeError(response, 400, "CommandCode received malformed OpenAI request JSON");
      return;
    }

    try {
      const upstream = await translateChatCompletion(payload, options, abort.signal);
      await writeWebResponse(response, upstream);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      writeError(
        response,
        502,
        error instanceof Error ? error.message : "CommandCode proxy request failed",
      );
    }
  };

  const server: Server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      writeError(
        response,
        500,
        error instanceof Error ? error.message : "CommandCode proxy request failed",
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("CommandCode proxy failed to bind a TCP port");

  return {
    port: address.port,
    baseURL: `http://${host}:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolve();
          else reject(error);
        });
        server.closeAllConnections();
      }),
  };
}
