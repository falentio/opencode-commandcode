import type { ModelId, ReasoningOptions } from "./catalog.js";
import { COMMAND_CODE_MODEL_METADATA } from "./models-dev.generated.js";

export const DEFAULT_OUTPUT_LIMIT = 64000;

export type StaticModelMetadata = {
  reasoning?: boolean;
  reasoningOptions?: ReasoningOptions;
  outputLimit?: number;
  temperature?: boolean;
  toolCall?: boolean;
  releaseDate?: string;
  vision?: boolean;
  sourceProvider: string;
};

export type StaticModelMetadataTable = Readonly<Record<string, StaticModelMetadata>>;
export type StaticModelMetadataLookup = (id: ModelId) => StaticModelMetadata | undefined;

export function lookupStaticModelMetadata(id: ModelId): StaticModelMetadata | undefined {
  return Object.hasOwn(COMMAND_CODE_MODEL_METADATA, id)
    ? COMMAND_CODE_MODEL_METADATA[id]
    : undefined;
}

export type ModelVariant = {
  id: string;
  settings: { reasoningEffort: string };
};
export function toModelVariants(
  options: ReasoningOptions | undefined,
): ModelVariant[] | undefined {
  if (!options) return undefined;

  const variants = new Map<string, ModelVariant>();
  for (const option of options) {
    if (option.type !== "effort") continue;
    for (const value of option.values) {
      variants.set(value, { id: value, settings: { reasoningEffort: value } });
    }
  }

  return variants.size > 0 ? [...variants.values()] : undefined;
}
