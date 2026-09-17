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
  it("matches the 9router request envelope and translations", () => {
    const body: OpenAIChatRequest = {
      model,
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: [{ type: "text", text: "Hello" }, { type: "image_url" }] },
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
      memory: "",
      config: {
        workingDir: process.cwd(),
        date: "2026-09-16",
        environment: process.platform,
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
              { type: "text", text: "[image omitted]" },
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
        stream: false,
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

  it("preserves 9router message and tool conversion behavior", () => {
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
      usage: { total_tokens: 9 },
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
    expect(parseAlphaEvent('data: {"type":"provider-metadata"}')).toBeUndefined();
    expect(parseAlphaEvent('data: {"type":"text-delta","text":"hello"}')).toEqual({
      type: "text-delta",
      text: "hello",
    });
  });
});
