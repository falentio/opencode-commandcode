import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { randomUUID } from "node:crypto";
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
import { COMMAND_CODE_ALPHA_URL, type FetchLike } from "./catalog.js";

export type CommandCodeRuntimeOptions = {
  apiKey?: string;
  fetch?: FetchLike;
};

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

  return {
    role,
    content: value.content,
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

  return {
    model: payload.model,
    messages,
    ...(stream === undefined ? {} : { stream }),
    ...(optionalNumber(payload, "max_tokens") === undefined
      ? {}
      : { max_tokens: optionalNumber(payload, "max_tokens") }),
    ...(optionalNumber(payload, "max_output_tokens") === undefined
      ? {}
      : { max_output_tokens: optionalNumber(payload, "max_output_tokens") }),
    ...(optionalNumber(payload, "temperature") === undefined
      ? {}
      : { temperature: optionalNumber(payload, "temperature") }),
    ...(optionalNumber(payload, "top_p") === undefined
      ? {}
      : { top_p: optionalNumber(payload, "top_p") }),
    ...(tools === undefined ? {} : { tools }),
  };
}

async function readRequestBody(body: RequestInit["body"]): Promise<unknown> {
  if (body == null) throw new Error("CommandCode received an empty OpenAI request body");
  const text = typeof body === "string" ? body : await new Response(body).text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("CommandCode received malformed OpenAI request JSON");
  }
}

function newRequestUUID(): UUID {
  return makeUUID(randomUUID());
}

export function makeCommandCodeFetch(options: CommandCodeRuntimeOptions): FetchLike {
  const fetcher = options.fetch ?? fetch;

  return async (_input, init) => {
    const body = decodeOpenAIChatRequest(await readRequestBody(init?.body));
    const request = buildAlphaRequest(body, () => new Date(), newRequestUUID);
    const sessionId = newRequestUUID();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-command-code-version": "0.25.7",
      "x-cli-environment": "cli",
      "x-session-id": sessionId,
      Accept: "text/event-stream",
    };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

    const response = await fetcher(COMMAND_CODE_ALPHA_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: init?.signal,
    });
    const wrapped = await inspectAndWrapAlphaResponse(response, request.model);
    return body.stream === true ? wrapped : collectOpenAISseAsJson(wrapped, request.model);
  };
}

export function createCommandCode(
  options: CommandCodeRuntimeOptions = {},
): OpenAICompatibleProvider {
  return createOpenAICompatible({
    name: "commandcode",
    baseURL: COMMAND_CODE_ALPHA_URL,
    apiKey: options.apiKey,
    fetch: makeCommandCodeFetch(options),
  });
}
