import { describe, expect, it, vi } from "vitest";
import {
  decodeCommandCodeCatalog,
  fetchCommandCodeCatalog,
  toCommandCodeModelConfig,
  type FetchLike,
} from "./catalog.js";

describe("CommandCode catalog", () => {
  it("decodes live model records and skips unusable entries", () => {
    const catalog = decodeCommandCodeCatalog({
      object: "list",
      data: [
        { id: "model-a", name: "Model A", context_length: 1000 },
        { id: "", name: "Missing ID", context_length: 1000 },
        { id: "model-b", name: "Missing context", context_length: 0 },
        { id: "model-c", context_length: 2000 },
      ],
    });

    expect(catalog).toEqual([
      { id: "model-a", name: "Model A", contextLength: 1000 },
      { id: "model-c", name: "model-c", contextLength: 2000 },
    ]);
  });

  it("rejects an empty usable catalog", () => {
    expect(() => decodeCommandCodeCatalog({ object: "list", data: [] })).toThrow(
      "contains no usable models",
    );
  });

  it("fetches the documented unauthenticated models endpoint", async () => {
    const fetcher: FetchLike = vi.fn(async (_input, init) => {
      expect(init?.headers).toEqual({ Accept: "application/json" });
      return new Response(JSON.stringify({ data: [{ id: "model-a", context_length: 1 }] }));
    });

    await expect(fetchCommandCodeCatalog(fetcher)).resolves.toHaveLength(1);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("maps catalog metadata to an OpenCode provider model", () => {
    const [item] = decodeCommandCodeCatalog({
      data: [{ id: "model-a", name: "Model A", context_length: 1000 }],
    });

    expect(toCommandCodeModelConfig(item)).toMatchObject({
      id: "model-a",
      name: "Model A",
      attachment: false,
      reasoning: true,
      temperature: true,
      tool_call: true,
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      limit: { context: 1000, output: 64000 },
      status: "active",
    });
  });
});
