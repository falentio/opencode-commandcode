import { makeModelId, type ModelId } from "./catalog.js";

export type UUID = string & {
  readonly __brand: "CommandCodeUUID";
};

export type CommandCodeContentBlock =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      output: { type: "text"; value: string };
    };

export type CommandCodeMessage = {
  role: "user" | "assistant" | "tool";
  content: readonly CommandCodeContentBlock[];
};

export type CommandCodeTool = {
  name: string;
  description?: string;
  input_schema: object;
};

export type CommandCodeConfig = {
  workingDir: string;
  date: string;
  environment: string;
  structure: readonly [];
  isGitRepo: false;
  currentBranch: "";
  mainBranch: "";
  gitStatus: "";
  recentCommits: readonly [];
};

export type CommandCodeParams = {
  model: ModelId;
  messages: readonly CommandCodeMessage[];
  stream: boolean;
  max_tokens: number;
  temperature: number;
  system?: string;
  tools?: readonly CommandCodeTool[];
  top_p?: number;
};

export type CommandCodeAlphaRequest = {
  model: ModelId;
  stream: true;
  threadId: UUID;
  memory: "";
  config: CommandCodeConfig;
  params: CommandCodeParams;
};

export type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  tool_calls?: readonly OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type OpenAIToolCall = {
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: unknown;
  };
};

export type OpenAITool = {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: object;
  };
  name?: string;
  description?: string;
  input_schema?: object;
  parameters?: object;
};

export type OpenAIChatRequest = {
  model: string;
  messages: readonly OpenAIMessage[];
  stream?: boolean;
  max_tokens?: number;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: readonly OpenAITool[];
};

export type AlphaUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type AlphaEvent =
  | {
      type:
        | "start"
        | "start-step"
        | "reasoning-start"
        | "reasoning-end"
        | "text-start"
        | "text-end";
    }
  | { type: "reasoning-delta"; text?: string }
  | { type: "text-delta"; text?: string; delta?: string }
  | { type: "tool-input-start"; id?: string; toolCallId?: string; toolName?: string }
  | {
      type: "tool-input-delta";
      id?: string;
      toolCallId?: string;
      delta?: string;
      inputTextDelta?: string;
    }
  | { type: "tool-input-end"; id?: string }
  | { type: "tool-call"; toolCallId?: string; toolName?: string; input?: unknown }
  | { type: "finish-step"; finishReason?: string; usage?: AlphaUsage }
  | { type: "finish"; finishReason?: string; totalUsage?: AlphaUsage }
  | { type: "error"; error?: unknown; message?: unknown; statusCode?: number };

type OpenAIChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: readonly [
    {
      index: 0;
      delta: {
        role?: "assistant";
        content?: string;
        reasoning_content?: string;
        tool_calls?: readonly OpenAIToolCallDelta[];
      };
      finish_reason: string | null;
    },
  ];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

type OpenAIToolCallDelta = {
  index: number;
  id?: string;
  type?: "function";
  function: { name?: string; arguments: string };
};

type OpenAIResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: readonly [
    {
      index: 0;
      message: {
        role: "assistant";
        content: string | null;
        reasoning_content?: string;
        tool_calls?: readonly {
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }[];
      };
      finish_reason: string;
    },
  ];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalUsage(record: Record<string, unknown>, key: string): AlphaUsage | undefined {
  const value = record[key];
  if (!isRecord(value)) return undefined;

  const inputTokens = optionalNumber(value, "inputTokens");
  const outputTokens = optionalNumber(value, "outputTokens");
  const totalTokens = optionalNumber(value, "totalTokens");
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

export function makeUUID(value: string): UUID {
  if (!isUUID(value)) {
    throw new Error("CommandCode session ID is not a UUID");
  }
  return value;
}

function isUUID(value: string): value is UUID {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function flattenText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (isRecord(part) && typeof part.text === "string") parts.push(part.text);
    }
    return parts.join("\n");
  }
  return String(content);
}

export function toContentBlocks(content: unknown): readonly CommandCodeContentBlock[] {
  if (content == null) return [{ type: "text", text: "" }];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    const blocks: CommandCodeContentBlock[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        blocks.push({ type: "text", text: part });
        continue;
      }
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") {
        blocks.push({ type: "text", text: part.text });
      } else if (part.type === "image_url" || part.type === "image") {
        blocks.push({ type: "text", text: "[image omitted]" });
      } else if (typeof part.text === "string") {
        blocks.push({ type: "text", text: part.text });
      }
    }
    return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
  }
  return [{ type: "text", text: String(content) }];
}

function safeParseJson(value: unknown): unknown {
  if (value == null) return {};
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function convertMessages(messages: readonly OpenAIMessage[]): {
  messages: readonly CommandCodeMessage[];
  system?: string;
} {
  const converted: CommandCodeMessage[] = [];
  const systemTexts: string[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = flattenText(message.content);
      if (text) systemTexts.push(text);
      continue;
    }

    if (message.role === "tool") {
      const value =
        typeof message.content === "string" ? message.content : flattenText(message.content);
      converted.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.tool_call_id || "",
            toolName: message.name || "",
            output: { type: "text", value },
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant") {
      const content: CommandCodeContentBlock[] = [];
      const text = flattenText(message.content);
      if (text) content.push({ type: "text", text });

      for (const toolCall of message.tool_calls ?? []) {
        content.push({
          type: "tool-call",
          toolCallId: toolCall.id || "",
          toolName: toolCall.function?.name || "",
          input: safeParseJson(toolCall.function?.arguments),
        });
      }

      converted.push({
        role: "assistant",
        content: content.length > 0 ? content : [{ type: "text", text: "" }],
      });
      continue;
    }

    converted.push({ role: "user", content: toContentBlocks(message.content) });
  }

  const system = systemTexts.join("\n\n");
  return system ? { messages: converted, system } : { messages: converted };
}

export function convertTools(
  tools: readonly OpenAITool[] | undefined,
): readonly CommandCodeTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const converted: CommandCodeTool[] = [];
  for (const tool of tools) {
    if (tool.type === "function" && tool.function) {
      converted.push({
        name: tool.function.name || "",
        description: tool.function.description,
        input_schema: tool.function.parameters || { type: "object" },
      });
      continue;
    }

    if (tool.name && (tool.input_schema || tool.parameters)) {
      converted.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema || tool.parameters || { type: "object" },
      });
    }
  }

  return converted.length > 0 ? converted : undefined;
}

export function buildAlphaRequest(
  body: OpenAIChatRequest,
  now: () => Date,
  newUUID: () => UUID,
): CommandCodeAlphaRequest {
  const model = makeModelId(body.model);
  const converted = convertMessages(body.messages);
  const params: CommandCodeParams = {
    model,
    messages: converted.messages,
    stream: body.stream === true,
    max_tokens: body.max_tokens ?? body.max_output_tokens ?? 64000,
    temperature: body.temperature ?? 0.3,
    ...(converted.system === undefined ? {} : { system: converted.system }),
    ...(body.top_p === undefined ? {} : { top_p: body.top_p }),
  };
  const tools = convertTools(body.tools);
  if (tools) params.tools = tools;

  return {
    model,
    stream: true,
    threadId: newUUID(),
    memory: "",
    config: {
      workingDir: process.cwd(),
      date: now().toISOString().slice(0, 10),
      environment: process.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    params,
  };
}

function errorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    const message = value.message ?? value.error;
    if (typeof message === "string") return message;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "unknown" : serialized;
}

type ParsedError = {
  statusCode: number;
  message: string;
  type: string;
};

function validStatus(value: unknown): number | undefined {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) && number >= 400 && number <= 599 ? number : undefined;
}

export function parseCommandCodeError(event: AlphaEvent): ParsedError {
  const value = event.type === "error" ? (event.error ?? event.message ?? "unknown") : undefined;
  const message = errorMessage(value);
  let statusCode: number | undefined;
  let type = "server_error";

  if (isRecord(value)) {
    statusCode = validStatus(value.statusCode) ?? validStatus(value.status);
    if (typeof value.type === "string") type = value.type;
  }
  if (event.type === "error") statusCode = validStatus(event.statusCode) ?? statusCode;

  if (statusCode === undefined) {
    const lower = message.toLowerCase();
    if (lower.includes("rate limit") || lower.includes("too many requests")) {
      statusCode = 429;
      type = "rate_limit_error";
    } else if (
      lower.includes("unauthorized") ||
      lower.includes("invalid api key") ||
      lower.includes("authentication")
    ) {
      statusCode = 401;
      type = "authentication_error";
    } else if (lower.includes("payment required") || lower.includes("billing")) {
      statusCode = 402;
      type = "billing_error";
    } else if (
      lower.includes("quota") ||
      lower.includes("forbidden") ||
      lower.includes("permission")
    ) {
      statusCode = 403;
      type = "permission_error";
    } else if (lower.includes("not found")) {
      statusCode = 404;
      type = "invalid_request_error";
    } else if (
      lower.includes("unavailable") ||
      lower.includes("overloaded") ||
      lower.includes("server error")
    ) {
      statusCode = 503;
    } else {
      statusCode = 503;
    }
  }

  return { statusCode, message, type };
}

function errorResponse(error: ParsedError): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `[CommandCode error: ${error.message}]`,
        type: error.type,
        code: error.statusCode,
      },
    }),
    {
      status: error.statusCode,
      statusText:
        error.statusCode === 503
          ? "Service Unavailable"
          : error.statusCode === 429
            ? "Too Many Requests"
            : "Bad Gateway",
      headers: { "Content-Type": "application/json" },
    },
  );
}

function errorFromHttpResponse(response: Response, body: string): Response {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = body;
  }

  const record = isRecord(payload) ? payload : undefined;
  const nested = record && isRecord(record.error) ? record.error : record;
  const message = nested ? (nested.message ?? nested.error) : payload;
  const type = nested && typeof nested.type === "string" ? nested.type : "server_error";
  const statusCode =
    validStatus(nested?.code) ?? validStatus(nested?.statusCode) ?? response.status;
  return errorResponse({
    statusCode: validStatus(statusCode) ?? 503,
    message: errorMessage(message),
    type,
  });
}

function isVisibleEvent(event: AlphaEvent | undefined): boolean {
  if (!event) return false;
  return (
    event.type === "text-delta" ||
    event.type === "reasoning-delta" ||
    event.type === "tool-input-start" ||
    event.type === "tool-call" ||
    event.type === "finish" ||
    event.type === "finish-step"
  );
}

export function parseAlphaEvent(line: string): AlphaEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const json = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!json || json === "[DONE]") return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(payload) || typeof payload.type !== "string") return undefined;

  switch (payload.type) {
    case "start":
    case "start-step":
    case "reasoning-start":
    case "reasoning-end":
    case "text-start":
    case "text-end":
      return { type: payload.type };
    case "reasoning-delta":
      return {
        type: "reasoning-delta",
        ...(optionalString(payload, "text") === undefined
          ? {}
          : { text: optionalString(payload, "text") }),
      };
    case "text-delta":
      return {
        type: "text-delta",
        ...(optionalString(payload, "text") === undefined
          ? {}
          : { text: optionalString(payload, "text") }),
        ...(optionalString(payload, "delta") === undefined
          ? {}
          : { delta: optionalString(payload, "delta") }),
      };
    case "tool-input-start":
      return {
        type: "tool-input-start",
        ...(optionalString(payload, "id") === undefined
          ? {}
          : { id: optionalString(payload, "id") }),
        ...(optionalString(payload, "toolCallId") === undefined
          ? {}
          : { toolCallId: optionalString(payload, "toolCallId") }),
        ...(optionalString(payload, "toolName") === undefined
          ? {}
          : { toolName: optionalString(payload, "toolName") }),
      };
    case "tool-input-delta":
      return {
        type: "tool-input-delta",
        ...(optionalString(payload, "id") === undefined
          ? {}
          : { id: optionalString(payload, "id") }),
        ...(optionalString(payload, "toolCallId") === undefined
          ? {}
          : { toolCallId: optionalString(payload, "toolCallId") }),
        ...(optionalString(payload, "delta") === undefined
          ? {}
          : { delta: optionalString(payload, "delta") }),
        ...(optionalString(payload, "inputTextDelta") === undefined
          ? {}
          : { inputTextDelta: optionalString(payload, "inputTextDelta") }),
      };
    case "tool-input-end":
      return {
        type: "tool-input-end",
        ...(optionalString(payload, "id") === undefined
          ? {}
          : { id: optionalString(payload, "id") }),
      };
    case "tool-call":
      return {
        type: "tool-call",
        ...(optionalString(payload, "toolCallId") === undefined
          ? {}
          : { toolCallId: optionalString(payload, "toolCallId") }),
        ...(optionalString(payload, "toolName") === undefined
          ? {}
          : { toolName: optionalString(payload, "toolName") }),
        ...(Object.hasOwn(payload, "input") ? { input: payload.input } : {}),
      };
    case "finish-step":
      return {
        type: "finish-step",
        ...(optionalString(payload, "finishReason") === undefined
          ? {}
          : { finishReason: optionalString(payload, "finishReason") }),
        ...(optionalUsage(payload, "usage") === undefined
          ? {}
          : { usage: optionalUsage(payload, "usage") }),
      };
    case "finish":
      return {
        type: "finish",
        ...(optionalString(payload, "finishReason") === undefined
          ? {}
          : { finishReason: optionalString(payload, "finishReason") }),
        ...(optionalUsage(payload, "totalUsage") === undefined
          ? {}
          : { totalUsage: optionalUsage(payload, "totalUsage") }),
      };
    case "error":
      return {
        type: "error",
        ...(Object.hasOwn(payload, "error") ? { error: payload.error } : {}),
        ...(Object.hasOwn(payload, "message") ? { message: payload.message } : {}),
        ...(optionalNumber(payload, "statusCode") === undefined
          ? {}
          : { statusCode: optionalNumber(payload, "statusCode") }),
      };
    default:
      return undefined;
  }
}

function createReplayStream(
  prefix: string,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: boolean,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let replayed = false;

  return new ReadableStream({
    async pull(controller) {
      if (!replayed) {
        replayed = true;
        if (prefix) controller.enqueue(encoder.encode(prefix));
      }
      if (done) {
        controller.close();
        return;
      }

      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

export async function inspectAndWrapAlphaResponse(
  response: Response,
  model: ModelId,
): Promise<Response> {
  if (!response.ok) {
    return errorFromHttpResponse(response, await response.text());
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let scanBuffer = "";
  let consumed = "";

  while (true) {
    const next = await reader.read();
    if (next.done) {
      const final = decoder.decode();
      scanBuffer += final;
      consumed += final;
      const event = parseAlphaEvent(scanBuffer);
      if (event?.type === "error") {
        await reader.cancel();
        return errorResponse(parseCommandCodeError(event));
      }
      return new Response(
        alphaNdjsonToOpenAISse(createReplayStream(consumed, reader, true), model),
        {
          status: response.status,
          statusText: response.statusText,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        },
      );
    }

    const text = decoder.decode(next.value, { stream: true });
    consumed += text;
    scanBuffer += text;
    const lines = scanBuffer.split("\n");
    scanBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const event = parseAlphaEvent(line);
      if (event?.type === "error") {
        await reader.cancel();
        return errorResponse(parseCommandCodeError(event));
      }
      if (isVisibleEvent(event)) {
        return new Response(
          alphaNdjsonToOpenAISse(createReplayStream(consumed, reader, false), model),
          {
            status: response.status,
            statusText: response.statusText,
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
          },
        );
      }
    }
  }
}

type StreamState = {
  responseId: string;
  created: number;
  model: string;
  chunkIndex: number;
  toolIndex: number;
  toolIndexById: Map<string, number>;
  finishReason: string | null;
  usage: AlphaUsage | undefined;
};

function createStreamState(model: ModelId): StreamState {
  return {
    responseId: `chatcmpl-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model,
    chunkIndex: 0,
    toolIndex: 0,
    toolIndexById: new Map(),
    finishReason: null,
    usage: undefined,
  };
}

function makeChunk(
  state: StreamState,
  delta: OpenAIChunk["choices"][0]["delta"],
  finishReason: string | null = null,
): OpenAIChunk {
  return {
    id: state.responseId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function toOpenAIFinish(reason: string | undefined): string {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool-calls":
    case "tool_use":
      return "tool_calls";
    case "content-filter":
      return "content_filter";
    case "error":
      return "stop";
    default:
      return reason || "stop";
  }
}

function fallbackToolCallId(index: number): string {
  return `call_${index}_${Date.now()}`;
}

function usageChunk(usage: AlphaUsage | undefined): OpenAIChunk["usage"] | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokens ?? promptTokens + completionTokens,
  };
}

function eventToChunks(event: AlphaEvent, state: StreamState): OpenAIChunk[] {
  switch (event.type) {
    case "text-delta": {
      const text = event.text || event.delta || "";
      if (!text) return [];
      const delta: OpenAIChunk["choices"][0]["delta"] =
        state.chunkIndex === 0 ? { role: "assistant", content: text } : { content: text };
      state.chunkIndex += 1;
      return [makeChunk(state, delta)];
    }
    case "reasoning-delta": {
      const text = event.text || "";
      if (!text) return [];
      const delta: OpenAIChunk["choices"][0]["delta"] =
        state.chunkIndex === 0
          ? { role: "assistant", reasoning_content: text }
          : { reasoning_content: text };
      state.chunkIndex += 1;
      return [makeChunk(state, delta)];
    }
    case "tool-input-start": {
      const id = event.id || event.toolCallId || fallbackToolCallId(state.toolIndex);
      let index = state.toolIndexById.get(id);
      if (index === undefined) {
        index = state.toolIndex;
        state.toolIndex += 1;
        state.toolIndexById.set(id, index);
      }
      const delta: OpenAIChunk["choices"][0]["delta"] = {
        ...(state.chunkIndex === 0 ? { role: "assistant" } : {}),
        tool_calls: [
          {
            index,
            id,
            type: "function",
            function: { name: event.toolName || "", arguments: "" },
          },
        ],
      };
      state.chunkIndex += 1;
      return [makeChunk(state, delta)];
    }
    case "tool-input-delta": {
      const id = event.id || event.toolCallId;
      if (!id) return [];
      const index = state.toolIndexById.get(id);
      if (index === undefined) return [];
      const delta = {
        tool_calls: [
          {
            index,
            function: { arguments: event.delta || event.inputTextDelta || "" },
          },
        ],
      };
      return [makeChunk(state, delta)];
    }
    case "tool-call": {
      const id = event.toolCallId || "";
      if (state.toolIndexById.has(id)) return [];
      const index = state.toolIndex;
      state.toolIndex += 1;
      state.toolIndexById.set(id, index);
      const argumentsText =
        typeof event.input === "string" ? event.input : (JSON.stringify(event.input ?? {}) ?? "{}");
      const delta: OpenAIChunk["choices"][0]["delta"] = {
        ...(state.chunkIndex === 0 ? { role: "assistant" } : {}),
        tool_calls: [
          {
            index,
            id,
            type: "function",
            function: { name: event.toolName || "", arguments: argumentsText },
          },
        ],
      };
      state.chunkIndex += 1;
      return [makeChunk(state, delta)];
    }
    case "finish-step":
      state.finishReason = toOpenAIFinish(event.finishReason);
      if (event.usage) state.usage = event.usage;
      return [];
    case "finish": {
      const finishReason = state.finishReason || toOpenAIFinish(event.finishReason || "stop");
      const chunk = makeChunk(state, {}, finishReason);
      const usage = usageChunk(event.totalUsage || state.usage);
      if (usage) chunk.usage = usage;
      return [chunk];
    }
    case "error": {
      const error = parseCommandCodeError(event);
      state.finishReason = "stop";
      return [
        makeChunk(state, { content: `\n\n[CommandCode error: ${error.message}]` }),
        makeChunk(state, {}, "stop"),
      ];
    }
    default:
      return [];
  }
}

function encodeChunks(chunks: readonly OpenAIChunk[], encoder: TextEncoder): Uint8Array[] {
  return chunks.map((chunk) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
}

export function alphaNdjsonToOpenAISse(
  body: ReadableStream<Uint8Array>,
  model: ModelId,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = createStreamState(model);
  let buffer = "";

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseAlphaEvent(line);
          if (event) {
            for (const encoded of encodeChunks(eventToChunks(event, state), encoder))
              controller.enqueue(encoded);
          }
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        const event = parseAlphaEvent(buffer);
        if (event) {
          for (const encoded of encodeChunks(eventToChunks(event, state), encoder))
            controller.enqueue(encoded);
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      },
    }),
  );
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function readUsage(value: unknown): OpenAIChunk["usage"] | undefined {
  if (!isRecord(value)) return undefined;
  const prompt = value.prompt_tokens;
  const completion = value.completion_tokens;
  const total = value.total_tokens;
  if (typeof prompt !== "number" || typeof completion !== "number" || typeof total !== "number")
    return undefined;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

export async function collectOpenAISseAsJson(
  response: Response,
  model: ModelId,
): Promise<Response> {
  if (!response.ok) return response;

  const text = await response.text();
  let responseId = `chatcmpl-${Date.now()}`;
  let created = Math.floor(Date.now() / 1000);
  let responseModel: string = model;
  let role: "assistant" = "assistant";
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage: OpenAIChunk["usage"] | undefined;
  const toolCalls = new Map<
    number,
    { id: string; type: "function"; function: { name: string; arguments: string } }
  >();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:") || trimmed.slice(5).trim() === "[DONE]") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed.slice(5).trim());
    } catch {
      continue;
    }
    if (!isRecord(payload)) continue;
    const id = readString(payload, "id");
    if (id) responseId = id;
    const createdValue = payload.created;
    if (typeof createdValue === "number") created = createdValue;
    const modelValue = readString(payload, "model");
    if (modelValue) responseModel = modelValue;
    const parsedUsage = readUsage(payload.usage);
    if (parsedUsage) usage = parsedUsage;

    if (!Array.isArray(payload.choices)) continue;
    const choice = payload.choices[0];
    if (!isRecord(choice)) continue;
    const reason = choice.finish_reason;
    if (typeof reason === "string") finishReason = reason;
    if (!isRecord(choice.delta)) continue;
    const delta = choice.delta;
    const textDelta = delta.content;
    if (typeof textDelta === "string") content += textDelta;
    const reasoningDelta = delta.reasoning_content;
    if (typeof reasoningDelta === "string") reasoning += reasoningDelta;
    if (delta.role === "assistant") role = "assistant";

    if (!Array.isArray(delta.tool_calls)) continue;
    for (const value of delta.tool_calls) {
      if (!isRecord(value) || typeof value.index !== "number") continue;
      const current = toolCalls.get(value.index) ?? {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      };
      const idValue = readString(value, "id");
      if (idValue) current.id = idValue;
      if (isRecord(value.function)) {
        const name = readString(value.function, "name");
        if (name) current.function.name = name;
        const argumentsDelta = readString(value.function, "arguments");
        if (argumentsDelta) current.function.arguments += argumentsDelta;
      }
      toolCalls.set(value.index, current);
    }
  }

  const message: OpenAIResponse["choices"][0]["message"] = {
    role,
    content: content || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.size > 0
      ? { tool_calls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value) }
      : {}),
  };
  const result: OpenAIResponse = {
    id: responseId,
    object: "chat.completion",
    created,
    model: responseModel,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
  return new Response(JSON.stringify(result), {
    status: response.status,
    statusText: response.statusText,
    headers: { "Content-Type": "application/json" },
  });
}
