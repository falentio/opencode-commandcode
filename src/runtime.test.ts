import { describe, expect, it, vi } from "vitest";
import { createCommandCode, makeCommandCodeFetch } from "./runtime.js";

const ndjson = [
  JSON.stringify({ type: "text-delta", text: "hello" }),
  JSON.stringify({
    type: "finish",
    totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  }),
].join("\n");

const requestBody = {
  model: "model-a",
  messages: [{ role: "user", content: "hello" }],
};

describe("CommandCode runtime", () => {
  it("constructs the exact alpha request and aggregates doGenerate output", async () => {
    const upstream = vi.fn(
      async (_input, init) => new Response(ndjson, { headers: init?.headers }),
    );
    const fetcher = makeCommandCodeFetch({ apiKey: "user_test", fetch: upstream });

    const response = await fetcher("https://ignored.invalid/chat/completions", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });
    const result: unknown = await response.json();
    const [input, init] = upstream.mock.calls[0];
    const sentBody: unknown = JSON.parse(String(init?.body));

    expect(input).toBe("https://api.commandcode.ai/alpha/generate");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-command-code-version": "0.25.7",
      "x-cli-environment": "cli",
      Accept: "text/event-stream",
      Authorization: "Bearer user_test",
    });
    expect((init?.headers as Record<string, string>)["x-session-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(sentBody).toMatchObject({
      model: "model-a",
      stream: true,
      params: { model: "model-a", stream: false, messages: [{ role: "user" }] },
    });
    expect(result).toMatchObject({
      object: "chat.completion",
      model: "model-a",
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { total_tokens: 3 },
    });
  });

  it("keeps doStream incremental and sets nested stream true", async () => {
    const upstream = vi.fn(
      async (_input, init) => new Response(ndjson, { headers: init?.headers }),
    );
    const fetcher = makeCommandCodeFetch({ fetch: upstream });
    const response = await fetcher("https://ignored.invalid/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...requestBody, stream: true }),
    });

    expect(await response.text()).toContain('"content":"hello"');
    const sentBody: unknown = JSON.parse(String(upstream.mock.calls[0][1]?.body));
    expect(sentBody).toMatchObject({ params: { stream: true } });
  });

  it("creates the provider factory expected by OpenCode's npm loader", () => {
    const provider = createCommandCode({ apiKey: "user_test", fetch: vi.fn() });
    const model = provider.languageModel("model-a");

    expect(provider.specificationVersion).toBe("v3");
    expect(model.modelId).toBe("model-a");
  });

  it("runs the complete AI SDK doGenerate path through the alpha bridge", async () => {
    const upstream = vi.fn(async () => new Response(ndjson));
    const model = createCommandCode({ apiKey: "user_test", fetch: upstream }).languageModel(
      "model-a",
    );

    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      maxOutputTokens: 32,
      temperature: 0.3,
    });

    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.finishReason.unified).toBe("stop");
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("runs the complete AI SDK doStream path through the alpha bridge", async () => {
    const upstream = vi.fn(async () => new Response(ndjson));
    const model = createCommandCode({ apiKey: "user_test", fetch: upstream }).languageModel("model-a");

    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      maxOutputTokens: 32,
      temperature: 0.3,
    });
    const reader = result.stream.getReader();
    const parts: unknown[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
    }

    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text-delta", delta: "hello" }),
        expect.objectContaining({
          type: "finish",
          finishReason: expect.objectContaining({ unified: "stop" }),
        }),
      ]),
    );
    expect(upstream).toHaveBeenCalledOnce();
  });
});
