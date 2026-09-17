import { describe, expect, it } from "vitest";
import { makeModelId } from "./catalog.js";
import { lookupStaticModelMetadata, toOpenCodeVariants } from "./model-metadata.js";

describe("CommandCode model metadata", () => {
  it("looks up complete, case-sensitive model IDs", () => {
    expect(lookupStaticModelMetadata(makeModelId("gpt-5.5"))).toMatchObject({
      outputLimit: 128000,
      sourceProvider: "opencode",
    });
    expect(lookupStaticModelMetadata(makeModelId("GPT-5.5"))).toBeUndefined();
    expect(lookupStaticModelMetadata(makeModelId("__proto__"))).toBeUndefined();
  });

  it("projects only explicit effort values into v1 variants", () => {
    expect(toOpenCodeVariants([{ type: "effort", values: ["low", "high", "high"] }])).toEqual({
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    });
    expect(toOpenCodeVariants([{ type: "toggle" }])).toBeUndefined();
    expect(toOpenCodeVariants([{ type: "budget_tokens", min: 1, max: 1000 }])).toBeUndefined();
    expect(toOpenCodeVariants([])).toBeUndefined();
  });
});
