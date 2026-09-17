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
  sourceProvider: string;
};

export type StaticModelMetadataTable = Readonly<Record<string, StaticModelMetadata>>;
export type StaticModelMetadataLookup = (id: ModelId) => StaticModelMetadata | undefined;

export function lookupStaticModelMetadata(id: ModelId): StaticModelMetadata | undefined {
  return Object.hasOwn(COMMAND_CODE_MODEL_METADATA, id)
    ? COMMAND_CODE_MODEL_METADATA[id]
    : undefined;
}

export type OpenCodeVariant = {
  reasoningEffort: string;
};

export type OpenCodeVariants = Record<string, OpenCodeVariant>;

export function toOpenCodeVariants(
  options: ReasoningOptions | undefined,
): OpenCodeVariants | undefined {
  if (!options) return undefined;

  const variants = new Map<string, OpenCodeVariant>();
  for (const option of options) {
    if (option.type !== "effort") continue;
    for (const value of option.values) {
      variants.set(value, { reasoningEffort: value });
    }
  }

  return variants.size > 0 ? Object.fromEntries(variants) : undefined;
}
