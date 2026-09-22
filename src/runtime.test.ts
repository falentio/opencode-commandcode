import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./catalog.js";
import { startCommandCodeProxy, translateChatCompletion, type CommandCodeProxyOptions } from "./runtime.js";

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
  max_tokens: 32,
};

type UpstreamCall = [string, RequestInit | undefined];

const open: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((proxy) => proxy.close()));
});

async function makeProxy(options: CommandCodeProxyOptions = {}) {
  const proxy = await startCommandCodeProxy(options);
  open.push(proxy);
  return proxy;
}

async function within<T>(promise: Promise<T>, label: string, ms = 2000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function recordingFetch(reply: () => Response): {
  fetcher: FetchLike;
  calls: UpstreamCall[];
} {
  const calls: UpstreamCall[] = [];
  const fetcher: FetchLike = async (input, init) => {
    calls.push([String(input), init]);
    return reply();
  };
  return { fetcher, calls };
}

function sentBody(call: UpstreamCall | undefined): unknown {
  return JSON.parse(String(call?.[1]?.body));
}

describe("CommandCode proxy runtime", () => {
  it("translates an OpenAI request into the alpha envelope and aggregates non-streaming output", async () => {
    const { fetcher, calls } = recordingFetch(() => new Response(ndjson));
    const response = await translateChatCompletion(requestBody, { apiKey: "user_test", fetch: fetcher });
    const result: unknown = await response.json();
    const call = calls[0];
    const headers = call?.[1]?.headers;

    expect(call?.[0]).toBe("https://api.commandcode.ai/alpha/generate");
    expect(call?.[1]?.method).toBe("POST");
    expect(headers).toMatchObject({
      "Content-Type": "application/json",
      "User-Agent": "cli",
      "x-command-code-version": "1.54.1",
      "x-cli-environment": "production",
      Accept: "text/event-stream",
      Authorization: "Bearer user_test",
    });
    if (headers === undefined) throw new Error("missing request headers");
    expect((headers as Record<string, string>)["x-session-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(sentBody(call)).toMatchObject({
      model: "model-a",
      stream: true,
      memory: null,
      permissionMode: "standard",
      params: { model: "model-a", stream: true, messages: [{ role: "user" }] },
    });
    expect(result).toMatchObject({
      object: "chat.completion",
      model: "model-a",
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { total_tokens: 3 },
    });
  });

  it("strips images on the wire when static metadata reports no vision", async () => {
    const { fetcher, calls } = recordingFetch(() => new Response(ndjson));
    await translateChatCompletion(
      {
        model: "model-a",
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abcd" } }],
          },
        ],
      },
      { fetch: fetcher, metadataLookup: () => ({ vision: false, sourceProvider: "static" }) },
    );

    expect(sentBody(calls[0])).toMatchObject({
      params: {
        messages: [
          { role: "user", content: [{ type: "text", text: '<attached_image index="0">' }] },
        ],
      },
    });
  });

  it("keeps streaming incremental and sets nested stream true", async () => {
    const { fetcher, calls } = recordingFetch(() => new Response(ndjson));
    const response = await translateChatCompletion(
      { ...requestBody, stream: true },
      { fetch: fetcher },
    );

    expect(await response.text()).toContain('"content":"hello"');
    expect(sentBody(calls[0])).toMatchObject({ params: { stream: true } });
  });

  it("cancels the upstream request when the client disconnects mid-stream", async () => {
    let upstreamAborted = false;
    let signal: AbortSignal | undefined;
    const fetcher: FetchLike = async (_input, init) => {
      signal = init?.signal ?? undefined;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "text-delta", text: "hello" })}\n`));
          signal?.addEventListener("abort", () => {
            upstreamAborted = true;
            controller.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return new Response(stream);
    };
    const proxy = await makeProxy({ fetch: fetcher });

    const client = new AbortController();
    const pending = fetch(`${proxy.baseURL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ ...requestBody, stream: true }),
      signal: client.signal,
    });
    const response = await within(pending, "the streamed response to start");
    const reader = response.body!.getReader();
    await within(reader.read(), "the first streamed chunk");
    client.abort();
    await reader.cancel().catch(() => undefined);

    const deadline = Date.now() + 2000;
    while (!upstreamAborted && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(upstreamAborted).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it("does not abort an upstream request that runs to completion", async () => {
    let signal: AbortSignal | undefined;
    const fetcher: FetchLike = async (_input, init) => {
      signal = init?.signal ?? undefined;
      return new Response(ndjson);
    };
    const proxy = await makeProxy({ fetch: fetcher });

    const response = await fetch(`${proxy.baseURL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ ...requestBody, stream: true }),
    });
    const text = await response.text();
    expect(text).toContain('"content":"hello"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);

    // Give the server's own response "close" event time to fire.
    await new Promise((r) => setTimeout(r, 100));
    expect(signal?.aborted).toBe(false);
  });

  it("accepts max_completion_tokens from the bundled OpenAI-compatible route", async () => {
    const { fetcher, calls } = recordingFetch(() => new Response(ndjson));
    await translateChatCompletion(
      {
        model: "model-a",
        messages: [{ role: "user", content: "hello" }],
        max_completion_tokens: 32,
      },
      { fetch: fetcher },
    );

    expect(sentBody(calls[0])).toMatchObject({ params: { max_tokens: 32 } });
    expect(calls).toHaveLength(1);
  });

  it("prefers max_tokens over max_completion_tokens when both are present", async () => {
    const { fetcher, calls } = recordingFetch(() => new Response(ndjson));
    await translateChatCompletion(
      {
        model: "model-a",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 11,
        max_completion_tokens: 22,
      },
      { fetch: fetcher },
    );

    expect(sentBody(calls[0])).toMatchObject({ params: { max_tokens: 11 } });
  });

  it("uses static output metadata when the request omits max tokens", async () => {
    const { fetcher, calls } = recordingFetch(() => new Response(ndjson));
    await translateChatCompletion(
      { model: "gpt-5.5", messages: [{ role: "user", content: "hello" }] },
      { fetch: fetcher },
    );

    expect(sentBody(calls[0])).toMatchObject({ params: { max_tokens: 128000 } });
  });

  it("uses 64000 for direct requests without static metadata", async () => {
    const { fetcher, calls } = recordingFetch(() => new Response(ndjson));
    await translateChatCompletion(
      { model: "unmatched/model", messages: [{ role: "user", content: "hi" }] },
      { fetch: fetcher },
    );

    expect(sentBody(calls[0])).toMatchObject({ params: { max_tokens: 64000 } });
  });

  it("does not forward invalid or empty reasoning effort values", async () => {
    const { fetcher, calls } = recordingFetch(() => new Response(ndjson));

    await translateChatCompletion(
      {
        model: "unmatched/model",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: 1,
      },
      { fetch: fetcher },
    );
    await translateChatCompletion(
      {
        model: "unmatched/model",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "",
      },
      { fetch: fetcher },
    );

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(sentBody(call)).toMatchObject({ params: { max_tokens: 64000 } });
      expect(sentBody(call)).not.toHaveProperty("params.reasoning_effort");
    }
  });

  it("forwards a valid reasoning effort as params.reasoning_effort", async () => {
    const { fetcher, calls } = recordingFetch(() => new Response(ndjson));
    await translateChatCompletion(
      {
        model: "model-a",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "high",
      },
      { fetch: fetcher },
    );

    expect(sentBody(calls[0])).toMatchObject({ params: { reasoning_effort: "high" } });
  });

  it("does not fetch models.dev at runtime", async () => {
    const { fetcher, calls } = recordingFetch(() => new Response(ndjson));
    await translateChatCompletion({ ...requestBody, model: "gpt-5.5" }, { fetch: fetcher });

    expect(calls.map(([input]) => input)).not.toContain(expect.stringContaining("models.dev"));
  });

  it("resolves the API key per request instead of once at startup", async () => {
    const keys = ["user_first", "user_second"];
    const { fetcher, calls } = recordingFetch(() => new Response(ndjson));
    const options = { fetch: fetcher, resolveApiKey: async () => keys.shift() };

    await translateChatCompletion(requestBody, options);
    await translateChatCompletion(requestBody, options);

    expect(calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer user_first" });
    expect(calls[1]?.[1]?.headers).toMatchObject({ Authorization: "Bearer user_second" });
  });

  it("falls back to the environment when no connection is active", async () => {
    const { fetcher, calls } = recordingFetch(() => new Response(ndjson));
    await translateChatCompletion(requestBody, {
      fetch: fetcher,
      env: { COMMANDCODE_API_KEY: "user_env" },
    });

    expect(calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer user_env" });
  });

  it("serves POST /v1/chat/completions as an OpenAI endpoint backed by the alpha wire", async () => {
    const { fetcher, calls } = recordingFetch(() => new Response(ndjson));
    const proxy = await makeProxy({ fetch: fetcher });

    const response = await fetch(`${proxy.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...requestBody, stream: true }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain('"content":"hello"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(calls[0]?.[0]).toBe("https://api.commandcode.ai/alpha/generate");
  });

  it("honors the alpha URL override so a local upstream can stand in", async () => {
    const { fetcher, calls } = recordingFetch(() => new Response(ndjson));
    await translateChatCompletion(requestBody, {
      fetch: fetcher,
      upstreamURL: "http://127.0.0.1:9/alpha/generate",
    });

    expect(calls[0]?.[0]).toBe("http://127.0.0.1:9/alpha/generate");
  });

  it("binds an ephemeral port on 127.0.0.1 and exposes it as baseURL", async () => {
    const proxy = await makeProxy({ fetch: vi.fn() as unknown as FetchLike });

    expect(proxy.port).toBeGreaterThan(0);
    expect(proxy.baseURL).toBe(`http://127.0.0.1:${proxy.port}/v1`);
  });

  it("lists catalog models on GET /v1/models", async () => {
    const proxy = await makeProxy({
      catalog: [
        {
          id: "model-a" as never,
          name: "Model A",
          contextLength: 1000,
          created: 1,
        },
      ],
    });

    const response = await fetch(`${proxy.baseURL}/models`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      object: "list",
      data: [
        {
          id: "model-a",
          object: "model",
          created: 1,
          owned_by: "command-code",
          name: "Model A",
          context_length: 1000,
        },
      ],
    });
  });

  it("rejects unknown routes with a JSON error", async () => {
    const proxy = await makeProxy();
    const response = await fetch(`http://127.0.0.1:${proxy.port}/nope`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "invalid_request_error" },
    });
  });

  it("surfaces upstream alpha errors as OpenAI error responses", async () => {
    const { fetcher } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({ error: { message: "invalid api key", type: "authentication" } }),
          { status: 401 },
        ),
    );
    const proxy = await makeProxy({ fetch: fetcher });

    const response = await fetch(`${proxy.baseURL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify(requestBody),
    });

    expect(response.status).toBe(401);
    const body: unknown = await response.json();
    expect(JSON.stringify(body)).toContain("invalid api key");
  });

  it("closes its listener on cleanup", async () => {
    const proxy = await startCommandCodeProxy({ fetch: vi.fn() as unknown as FetchLike });
    const url = `${proxy.baseURL}/models`;
    await proxy.close();

    await expect(fetch(url)).rejects.toThrow();
  });

  it("closes twice without rejecting", async () => {
    const proxy = await startCommandCodeProxy({ fetch: vi.fn() as unknown as FetchLike });
    await proxy.close();
    await expect(proxy.close()).resolves.toBeUndefined();
  });

      it("emits an SSE error frame when the upstream fails mid-stream", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "text-delta", text: "hello" })}\n`));
      },
      pull() {
        throw new Error("upstream connection reset");
      },
    });
    const proxy = await makeProxy({ fetch: async () => new Response(stream) });

    const response = await fetch(`${proxy.baseURL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ ...requestBody, stream: true }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"content":"hello"');
    expect(text).toContain("CommandCode upstream stream failed: upstream connection reset");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});
