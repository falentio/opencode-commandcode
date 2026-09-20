import { describe, expect, it, vi } from "vitest";
import {
  decodeCommandCodeCatalog,
  fetchCommandCodeCatalog,
  makeModelId,
  toCommandCodeModelConfig,
  type CommandCodeCatalogItem,
  type CommandCodeEndpointMetadata,
  type EndpointField,
  type FetchLike,
} from "./catalog.js";
import type { StaticModelMetadata } from "./model-metadata.js";

const absent = <T>(): EndpointField<T> => ({ state: "absent" });

const endpoint = (overrides: Partial<CommandCodeEndpointMetadata> = {}): CommandCodeEndpointMetadata => ({
  reasoning: absent(),
  reasoningOptions: absent(),
  outputLimit: absent(),
  temperature: absent(),
  toolCall: absent(),
  releaseDate: absent(),
  ...overrides,
});

const item = (
  endpointOverrides: Partial<CommandCodeEndpointMetadata> = {},
  overrides: Partial<CommandCodeCatalogItem> = {},
): CommandCodeCatalogItem => ({
  id: makeModelId("zai-org/GLM-5.2"),
  name: "GLM-5.2",
  contextLength: 1000000,
  endpoint: endpoint(endpointOverrides),
  ...overrides,
});

describe("CommandCode catalog", () => {
  it("decodes old records with absent optional metadata", () => {
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
      {
        id: "model-a",
        name: "Model A",
        contextLength: 1000,
      },
      {
        id: "model-c",
        name: "model-c",
        contextLength: 2000,
      },
    ]);
  });

  it("parses endpoint metadata and preserves explicit empty values", () => {
    const catalog = decodeCommandCodeCatalog({
      data: [
        {
          id: "model-a",
          context_length: 1000,
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "high"] }],
          limit: { output: 123 },
          temperature: false,
          tool_call: false,
          created: 1789549210,
        },
        {
          id: "model-b",
          context_length: 1000,
          reasoning: false,
          reasoning_options: [],
          max_output_tokens: 456,
        },
      ],
    });

    expect(catalog[0]).toMatchObject({
      endpoint: {
        reasoning: { state: "known", value: true },
        reasoningOptions: {
          state: "known",
          value: [{ type: "effort", values: ["low", "high"] }],
        },
        outputLimit: { state: "known", value: 123 },
        temperature: { state: "known", value: false },
        toolCall: { state: "known", value: false },
        releaseDate: { state: "absent" },
      },
    });
    expect(catalog[1]?.endpoint).toEqual({
      reasoning: { state: "known", value: false },
      reasoningOptions: { state: "known", value: [] },
      outputLimit: { state: "known", value: 456 },
      temperature: { state: "absent" },
      toolCall: { state: "absent" },
      releaseDate: { state: "absent" },
    });
  });

  it("blocks malformed recognized metadata instead of falling back to static values", () => {
    const [model] = decodeCommandCodeCatalog({
      data: [
        {
          id: "model-a",
          context_length: 1000,
          reasoning: "yes",
          reasoning_options: "invalid",
          limit: { output: "invalid" },
          temperature: "sometimes",
          tool_call: 1,
          created: 1789549210,
          release_date: 1,
        },
      ],
    });

    expect(model?.endpoint).toEqual({
      reasoning: { state: "blocked" },
      reasoningOptions: { state: "blocked" },
      outputLimit: { state: "blocked" },
      temperature: { state: "blocked" },
      toolCall: { state: "blocked" },
      releaseDate: { state: "blocked" },
    });
    expect(
      toCommandCodeModelConfig(model!, { releaseDate: "2025-01-01", sourceProvider: "static" }),
    ).not.toHaveProperty("release_date");
  });

  it("uses known endpoint values over static values", () => {
    const model = toCommandCodeModelConfig(
      item({
        reasoning: { state: "known", value: false },
        reasoningOptions: { state: "known", value: [{ type: "effort", values: ["low"] }] },
        outputLimit: { state: "known", value: 123 },
        temperature: { state: "known", value: false },
        toolCall: { state: "known", value: false },
        releaseDate: { state: "known", value: "2026-01-01" },
      }),
      {
        reasoning: true,
        reasoningOptions: [{ type: "effort", values: ["max"] }],
        outputLimit: 999,
        temperature: true,
        toolCall: true,
        releaseDate: "2025-01-01",
        sourceProvider: "static",
      },
    );

    expect(model).toMatchObject({
      reasoning: false,
      temperature: false,
      tool_call: false,
      release_date: "2026-01-01",
      limit: { context: 1000000, output: 123 },
    });
    expect(model.variants).toBeUndefined();
  });

  it("falls back per field and lets explicit empty or blocked values suppress variants", () => {
    const staticMetadata: StaticModelMetadata = {
      reasoning: true,
      reasoningOptions: [{ type: "effort", values: ["high", "max"] }],
      outputLimit: 999,
      sourceProvider: "static",
    };

    expect(
      toCommandCodeModelConfig(item({ reasoning: { state: "known", value: true } }), staticMetadata)
        .variants,
    ).toEqual({ high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } });
    expect(
      toCommandCodeModelConfig(
        item({ reasoningOptions: { state: "known", value: [] } }),
        staticMetadata,
      ).variants,
    ).toBeUndefined();
    expect(
      toCommandCodeModelConfig(
        item({ reasoningOptions: { state: "blocked" }, outputLimit: { state: "blocked" } }),
        staticMetadata,
      ),
    ).toMatchObject({ limit: { output: 64000 } });
    expect(
      toCommandCodeModelConfig(item(), undefined),
    ).toMatchObject({ limit: { context: 1000000, output: 64000 } });
  });

  it("treats endpoint effort options as reasoning support", () => {
    const model = toCommandCodeModelConfig(
      item({
        reasoningOptions: { state: "known", value: [{ type: "effort", values: ["high"] }] },
      }),
      { reasoning: false, sourceProvider: "static" },
    );

    expect(model).toMatchObject({
      reasoning: true,
      variants: { high: { reasoningEffort: "high" } },
    });
  });

  it("advertises image input only for models with vision support", () => {
    expect(
      toCommandCodeModelConfig(item(), { vision: true, sourceProvider: "static" }),
    ).toMatchObject({ attachment: true, modalities: { input: ["text", "image"] } });
    expect(
      toCommandCodeModelConfig(item(), { vision: false, sourceProvider: "static" }),
    ).toMatchObject({ attachment: false, modalities: { input: ["text"] } });
    expect(toCommandCodeModelConfig(item(), undefined)).toMatchObject({
      attachment: true,
      modalities: { input: ["text", "image"] },
    });
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
});
