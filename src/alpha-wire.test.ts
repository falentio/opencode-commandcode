import { describe, expect, it } from "vitest";
import {
  alphaNdjsonToOpenAISse,
  buildAlphaRequest,
  collectOpenAISseAsJson,
  convertMessages,
  convertTools,
  inspectAndWrapAlphaResponse,
  makeUUID,
  parseAlphaEvent,
  resolveMaxTokens,
  TEXT_ONLY_IMAGE_FALLBACK,
  type OpenAIChatRequest,
} from "./alpha-wire.js";
import { makeModelId } from "./catalog.js";

const uuid = makeUUID("00000000-0000-4000-8000-000000000000");
const model = makeModelId("moonshotai/Kimi-K2.6");

async function readSseChunks(response: Response): Promise<Record<string, unknown>[]> {
  const chunks: Record<string, unknown>[] = [];
  for (const line of (await response.text()).split("\n")) {
    if (!line.startsWith("data: {") || line.endsWith("[DONE]")) continue;
    const value: unknown = JSON.parse(line.slice(6));
    if (typeof value === "object" && value !== null) chunks.push(value as Record<string, unknown>);
  }
  return chunks;
}

describe("CommandCode alpha wire", () => {
  it("matches the gateway request envelope and translations", () => {
    const body: OpenAIChatRequest = {
      model,
      messages: [
        { role: "system", content: "Be concise." },
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abcd" } },
          ],
        },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call-1", type: "function", function: { name: "lookup", arguments: "not-json" } },
          ],
        },
        { role: "tool", content: "result", tool_call_id: "call-1", name: "lookup" },
      ],
      stream: false,
      max_output_tokens: 123,
      reasoning_effort: "high",
      temperature: 0.2,
      top_p: 0.8,
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    };

    const request = buildAlphaRequest(
      body,
      () => new Date("2026-09-16T12:00:00.000Z"),
      () => uuid,
    );

    expect(request).toEqual({
      model,
      stream: true,
      threadId: uuid,
      memory: null,
      taste: null,
      skills: null,
      permissionMode: "standard",
      config: {
        workingDir: process.cwd(),
        date: "2026-09-16",
        environment: `${process.platform} ${process.arch}`,
        structure: [],
        isGitRepo: false,
        currentBranch: "",
        mainBranch: "",
        gitStatus: "",
        recentCommits: [],
      },
      params: {
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Hello" },
              { type: "image", image: "data:image/png;base64,abcd", mimeType: "image/png" },
            ],
          },
          {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: {} }],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "lookup",
                output: { type: "text", value: "result" },
              },
            ],
          },
        ],
        stream: true,
        max_tokens: 123,
        reasoning_effort: "high",
        temperature: 0.2,
        system: "Be concise.",
        top_p: 0.8,
        tools: [{ name: "lookup", description: undefined, input_schema: { type: "object" } }],
      },
    });
  });

  it("resolves explicit and metadata output limits with a safe fallback", () => {
    expect(resolveMaxTokens({ max_tokens: 1, max_output_tokens: 2 }, 3)).toBe(1);
    expect(resolveMaxTokens({ max_output_tokens: 2 }, 3)).toBe(2);
    expect(resolveMaxTokens({}, 3)).toBe(3);
    expect(resolveMaxTokens({}, undefined)).toBe(64000);
  });

  it("only puts non-empty reasoning effort strings on the alpha wire", () => {
    const base: OpenAIChatRequest = { model, messages: [{ role: "user", content: "hello" }] };
    expect(buildAlphaRequest({ ...base, reasoning_effort: "high" }, () => new Date(), () => uuid).params)
      .toMatchObject({ reasoning_effort: "high" });
    expect(buildAlphaRequest({ ...base, reasoning_effort: "" }, () => new Date(), () => uuid).params)
      .not.toHaveProperty("reasoning_effort");
    expect(
      buildAlphaRequest(
        { ...base, reasoning_effort: 1 as unknown as string },
        () => new Date(),
        () => uuid,
      ).params,
    ).not.toHaveProperty("reasoning_effort");
  });

  it("preserves gateway message and tool conversion behavior", () => {
    expect(
      convertMessages([{ role: "user", content: ["one", { type: "custom", text: "two" }] }]),
    ).toEqual({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "one" },
            { type: "text", text: "two" },
          ],
        },
      ],
    });
    expect(
      convertTools([{ type: "function", function: { name: "lookup" } }, { type: "ignored" }]),
    ).toEqual([{ name: "lookup", description: undefined, input_schema: { type: "object" } }]);
  });

  it("omits temperature when the caller does not set it", () => {
    const base: OpenAIChatRequest = { model, messages: [{ role: "user", content: "hello" }] };
    expect(
      buildAlphaRequest({ ...base, temperature: 0.2 }, () => new Date(), () => uuid).params,
    ).toMatchObject({ temperature: 0.2 });
    expect(buildAlphaRequest(base, () => new Date(), () => uuid).params).not.toHaveProperty(
      "temperature",
    );
  });

  it("renames tool_search, falls back to unknown ids, and resolves tool names", () => {
    const { messages } = convertMessages([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call-1", type: "function", function: { name: "tool_search", arguments: "{}" } },
          { id: "", type: "function", function: { name: "lookup", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "a", tool_call_id: "call-1" },
      { role: "tool", content: "b" },
    ]);

    expect(messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "call-1", toolName: "search_tools", input: {} },
        { type: "tool-call", toolCallId: "unknown", toolName: "lookup", input: {} },
      ],
    });
    expect(messages[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "search_tools",
          output: { type: "text", value: "a" },
        },
      ],
    });
    expect(messages[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "unknown",
          toolName: "",
          output: { type: "text", value: "b" },
        },
      ],
    });
  });

  it("passes reasoning blocks through to the gateway", () => {
    const { messages } = convertMessages([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "answer" },
        ],
        reasoning_content: "earlier thought",
      },
    ]);

    expect(messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "earlier thought" },
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "answer" },
      ],
    });
  });

  it("converts user image parts to gateway image blocks", () => {
    const { messages } = convertMessages([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,zzzz" } },
          { type: "image_url", image_url: { url: "https://example.com/pic.png" } },
        ],
      },
    ]);

    expect(messages[0]).toEqual({
      role: "user",
      content: [
        { type: "image", image: "data:image/jpeg;base64,zzzz", mimeType: "image/jpeg" },
        { type: "text", text: "[image: https://example.com/pic.png]" },
      ],
    });
  });

  it("strips images for models without vision support", () => {
    const image = {
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,zzzz" },
    };
    const { messages } = convertMessages(
      [
        { role: "user", content: ["first", image] },
        { role: "user", content: [image] },
        { role: "user", content: ["last", image] },
      ],
      false,
    );

    expect(messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "first" }],
    });
    expect(messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: TEXT_ONLY_IMAGE_FALLBACK }],
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "last" },
        { type: "text", text: '<attached_image index="0">' },
      ],
    });
  });

  it("keeps images when vision support is unknown", () => {
    const { messages } = convertMessages(
      [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abcd" } }],
        },
      ],
      undefined,
    );

    expect(messages[0]).toEqual({
      role: "user",
      content: [{ type: "image", image: "data:image/png;base64,abcd", mimeType: "image/png" }],
    });
  });

  it("keeps images for vision-capable models", () => {
    const { messages } = convertMessages(
      [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abcd" } }],
        },
      ],
      true,
    );

    expect(messages[0]).toEqual({
      role: "user",
      content: [{ type: "image", image: "data:image/png;base64,abcd", mimeType: "image/png" }],
    });
  });

  it("strips images in the built request when the model lacks vision", () => {
    const body: OpenAIChatRequest = {
      model,
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abcd" } }],
        },
      ],
    };
    const request = buildAlphaRequest(
      body,
      () => new Date("2026-09-16T12:00:00.000Z"),
      () => uuid,
      undefined,
      false,
    );

    expect(request.params.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: '<attached_image index="0">' }],
      },
    ]);
  });

  it("maps NDJSON events to OpenAI SSE with usage and tool deltas", async () => {
    const upstream = new Response(
      [
        JSON.stringify({ type: "start" }),
        JSON.stringify({ type: "text-delta", text: "hello" }),
        JSON.stringify({ type: "reasoning-delta", text: "think" }),
        JSON.stringify({ type: "tool-input-start", id: "call-1", toolName: "lookup" }),
        JSON.stringify({ type: "tool-input-delta", id: "call-1", delta: '{"q":"x"}' }),
        JSON.stringify({
          type: "finish-step",
          finishReason: "tool-calls",
          usage: { inputTokens: 4, outputTokens: 5 },
        }),
        JSON.stringify({
          type: "provider-metadata",
          usage: { inputTokens: 4, outputTokens: 5, cacheReadTokens: 3 },
        }),
        JSON.stringify({
          type: "finish",
          totalUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
        }),
      ].join("\n"),
    );
    const output = new Response(alphaNdjsonToOpenAISse(upstream.body!, model));
    const chunks = await readSseChunks(output);

    expect(chunks[0]).toMatchObject({
      choices: [{ delta: { role: "assistant", content: "hello" } }],
    });
    expect(chunks[1]).toMatchObject({ choices: [{ delta: { reasoning_content: "think" } }] });
    expect(chunks[2]).toMatchObject({
      choices: [{ delta: { tool_calls: [{ id: "call-1", function: { name: "lookup" } }] } }],
    });
    expect(chunks[3]).toMatchObject({
      choices: [{ delta: { tool_calls: [{ function: { arguments: '{"q":"x"}' } }] } }],
    });
    expect(chunks[4]).toMatchObject({
      choices: [{ finish_reason: "tool_calls" }],
      usage: { total_tokens: 9, prompt_tokens_details: { cached_tokens: 3 } },
    });
  });

  it("normalizes an alpha error event before exposing a stream", async () => {
    const response = await inspectAndWrapAlphaResponse(
      new Response(
        `${JSON.stringify({ type: "start" })}\n${JSON.stringify({ type: "error", error: "rate limit" })}\n`,
      ),
      model,
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: { message: "[CommandCode error: rate limit]", type: "rate_limit_error", code: 429 },
    });
  });

  it("aggregates the forced stream into an OpenAI JSON response", async () => {
    const sse = new Response(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"model-a","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"model-a","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n' +
        "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    );

    expect(await (await collectOpenAISseAsJson(sse, model)).json()).toEqual({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: "model-a",
      choices: [
        { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
  });

  it("parses data-prefixed events and ignores unsupported event types", () => {
    expect(parseAlphaEvent('data: {"type":"provider-metadata"}')).toEqual({
      type: "provider-metadata",
    });
    expect(
      parseAlphaEvent(
        'data: {"type":"provider-metadata","usage":{"inputTokens":1,"cacheReadTokens":2}}',
      ),
    ).toEqual({
      type: "provider-metadata",
      usage: { inputTokens: 1, cacheReadTokens: 2 },
    });
    expect(parseAlphaEvent('data: {"type":"server_tool_result"}')).toBeUndefined();
    expect(parseAlphaEvent('data: {"type":"text-delta","text":"hello"}')).toEqual({
      type: "text-delta",
      text: "hello",
    });
  });
});
