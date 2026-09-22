import { describe, expect, it, vi } from "vitest";
import {
  decodeCommandCodeCatalog,
  fetchCommandCodeCatalog,
  makeModelId,
  resolveCommandCodeCatalogURL,
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
      toCommandCodeModelConfig(model!, { releaseDate: "2025-01-01", sourceProvider: "static" }).time
        .released,
    ).toBe(1789549210000);
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
      capabilities: { tools: false, input: ["text", "image"], output: ["text"] },
      limit: { context: 1000000, output: 123 },
      time: { released: Date.parse("2026-01-01T00:00:00Z") },
    });
    expect(model.variants).toEqual([]);
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
    ).toEqual([
      { id: "high", settings: { reasoningEffort: "high" } },
      { id: "max", settings: { reasoningEffort: "max" } },
    ]);
    expect(
      toCommandCodeModelConfig(
        item({ reasoningOptions: { state: "known", value: [] } }),
        staticMetadata,
      ).variants,
    ).toEqual([]);
    expect(
      toCommandCodeModelConfig(
        item({ reasoningOptions: { state: "blocked" }, outputLimit: { state: "blocked" } }),
        staticMetadata,
      ),
    ).toMatchObject({ limit: { output: 64000 } });
    expect(toCommandCodeModelConfig(item(), undefined)).toMatchObject({
      limit: { context: 1000000, output: 64000 },
    });
  });

  it("treats endpoint effort options as reasoning support", () => {
    const model = toCommandCodeModelConfig(
      item({
        reasoningOptions: { state: "known", value: [{ type: "effort", values: ["high"] }] },
      }),
      { reasoning: false, sourceProvider: "static" },
    );

    expect(model).toMatchObject({
      variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
    });
  });

  it("advertises image input only for models with vision support", () => {
    expect(
      toCommandCodeModelConfig(item(), { vision: true, sourceProvider: "static" }),
    ).toMatchObject({ capabilities: { input: ["text", "image"] } });
    expect(
      toCommandCodeModelConfig(item(), { vision: false, sourceProvider: "static" }),
    ).toMatchObject({ capabilities: { input: ["text"] } });
    expect(toCommandCodeModelConfig(item(), undefined)).toMatchObject({
      capabilities: { input: ["text", "image"] },
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

  it("resolves the catalog URL from the environment when overridden", () => {
    expect(resolveCommandCodeCatalogURL({})).toBe(
      "https://api.commandcode.ai/provider/v1/models",
    );
    expect(resolveCommandCodeCatalogURL({ COMMANDCODE_CATALOG_URL: "" })).toBe(
      "https://api.commandcode.ai/provider/v1/models",
    );
    expect(resolveCommandCodeCatalogURL({ COMMANDCODE_CATALOG_URL: "http://127.0.0.1:1/x" })).toBe(
      "http://127.0.0.1:1/x",
    );
  });

  // The plugin hands these objects to opencode, which decodes them with its own
  // `Model.Info` schema before the provider can serve a request. A shape that
  // drifts here fails at model resolution, not in this package.
  it("projects models that satisfy the opencode Model.Info schema", async () => {
    const { Schema } = await import("effect");
    const { Model } = await import("@opencode/schema/model");
    const decode = Schema.decodeUnknownSync(Model.Info);

    const cases = [
      toCommandCodeModelConfig(item(), undefined),
      toCommandCodeModelConfig(
        item({
          reasoningOptions: { state: "known", value: [{ type: "effort", values: ["low", "high"] }] },
          outputLimit: { state: "known", value: 384000 },
        }),
        { reasoning: true, sourceProvider: "static", vision: true },
        { baseURL: "http://127.0.0.1:1/v1" },
      ),
      toCommandCodeModelConfig(
        item({ releaseDate: { state: "known", value: "2026-01-02" } }),
        { reasoning: false, sourceProvider: "static", vision: false },
      ),
    ];

    for (const projected of cases) {
      expect(() => decode(projected)).not.toThrow();
    }
  });
});
