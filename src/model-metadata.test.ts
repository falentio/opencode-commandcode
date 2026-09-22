import { describe, expect, it } from "vitest";
import { makeModelId } from "./catalog.js";
import { lookupStaticModelMetadata, toModelVariants } from "./model-metadata.js";

describe("CommandCode model metadata", () => {
  it("looks up complete, case-sensitive model IDs", () => {
    expect(lookupStaticModelMetadata(makeModelId("gpt-5.5"))).toMatchObject({
      outputLimit: 128000,
      sourceProvider: "opencode",
    });
    expect(lookupStaticModelMetadata(makeModelId("GPT-5.5"))).toBeUndefined();
    expect(lookupStaticModelMetadata(makeModelId("__proto__"))).toBeUndefined();
  });

  it("projects only explicit effort values into Model.Info variants", () => {
    expect(toModelVariants([{ type: "effort", values: ["low", "high", "high"] }])).toEqual([
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ]);
    expect(toModelVariants([{ type: "toggle" }])).toBeUndefined();
    expect(toModelVariants([{ type: "budget_tokens", min: 1, max: 1000 }])).toBeUndefined();
    expect(toModelVariants([])).toBeUndefined();
  });
});
