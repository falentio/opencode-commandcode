import type { Config } from "@opencode-ai/plugin";
import {
  DEFAULT_OUTPUT_LIMIT,
  lookupStaticModelMetadata,
  toOpenCodeVariants,
  type OpenCodeVariants,
  type StaticModelMetadata,
  type StaticModelMetadataLookup,
} from "./model-metadata.js";

export const COMMAND_CODE_CATALOG_URL = "https://api.commandcode.ai/provider/v1/models";
export const COMMAND_CODE_ALPHA_URL = "https://api.commandcode.ai/alpha/generate";

export type FetchLike = typeof fetch;

export type ModelId = string & {
  readonly __brand: "CommandCodeModelId";
};

export type ReasoningOption =
  | { type: "toggle" }
  | { type: "effort"; values: readonly string[] }
  | { type: "budget_tokens"; min?: number; max?: number };

export type ReasoningOptions = readonly ReasoningOption[];

export type EndpointField<T> =
  | { state: "absent" }
  | { state: "known"; value: T }
  | { state: "blocked" };

export type CommandCodeEndpointMetadata = {
  reasoning: EndpointField<boolean>;
  reasoningOptions: EndpointField<ReasoningOptions>;
  outputLimit: EndpointField<number>;
  temperature: EndpointField<boolean>;
  toolCall: EndpointField<boolean>;
  releaseDate: EndpointField<string>;
};

export type CommandCodeCatalogItem = {
  id: ModelId;
  name: string;
  contextLength: number;
  created?: number;
  endpoint?: CommandCodeEndpointMetadata;
};

export type CommandCodeCatalog = readonly CommandCodeCatalogItem[];

type OpenCodeModelConfig = NonNullable<
  NonNullable<NonNullable<Config["provider"]>[string]["models"]>[string]
>;

export type CommandCodeOpenCodeModel = OpenCodeModelConfig & {
  variants?: OpenCodeVariants;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isModelId(value: string): value is ModelId {
  return value.length > 0 && value.trim() === value;
}

export function makeModelId(value: string): ModelId {
  if (!isModelId(value)) throw new Error("CommandCode model ID must be non-empty");
  return value;
}

function absent<T>(): EndpointField<T> {
  return { state: "absent" };
}

function known<T>(value: T): EndpointField<T> {
  return { state: "known", value };
}

function blocked<T>(): EndpointField<T> {
  return { state: "blocked" };
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseReasoningOptions(value: unknown): ReasoningOptions | undefined {
  if (!Array.isArray(value)) return undefined;

  const options: ReasoningOption[] = [];
  for (const option of value) {
    if (!isRecord(option) || typeof option.type !== "string") return undefined;

    if (option.type === "toggle") {
      options.push({ type: "toggle" });
      continue;
    }

    if (option.type === "effort") {
      if (
        !Array.isArray(option.values) ||
        option.values.length === 0 ||
        option.values.some(
          (effort) => typeof effort !== "string" || effort.length === 0 || effort.trim() !== effort,
        )
      ) {
        return undefined;
      }
      options.push({ type: "effort", values: option.values });
      continue;
    }

    if (option.type === "budget_tokens") {
      const min = optionalNumber(option, "min");
      const max = optionalNumber(option, "max");
      if (
        (Object.hasOwn(option, "min") && min === undefined) ||
        (Object.hasOwn(option, "max") && max === undefined) ||
        (min !== undefined && max !== undefined && min > max)
      ) {
        return undefined;
      }
      options.push({
        type: "budget_tokens",
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
      });
      continue;
    }

    return undefined;
  }

  return options;
}

function parseField<T>(
  record: Record<string, unknown>,
  key: string,
  parser: (value: unknown) => T | undefined,
): EndpointField<T> {
  if (!Object.hasOwn(record, key)) return absent();
  const value = parser(record[key]);
  return value === undefined ? blocked() : known(value);
}

function parseOutputLimit(record: Record<string, unknown>): EndpointField<number> {
  const limitField: EndpointField<number> = (() => {
    if (!Object.hasOwn(record, "limit")) return absent<number>();
    const limit = record.limit;
    if (!isRecord(limit)) return blocked<number>();
    if (!Object.hasOwn(limit, "output")) return absent<number>();
    const output = positiveNumber(limit.output);
    return output === undefined ? blocked() : known(output);
  })();
  const maxOutputField = parseField(record, "max_output_tokens", positiveNumber);

  if (limitField.state === "blocked" || maxOutputField.state === "blocked") return blocked();
  if (limitField.state === "known") return limitField;
  return maxOutputField;
}

function parseReleaseDate(record: Record<string, unknown>): EndpointField<string> {
  if (Object.hasOwn(record, "release_date")) {
    const value = record.release_date;
    return typeof value === "string" && value.length > 0 ? known(value) : blocked();
  }
  return absent();
}

function readEndpointMetadata(record: Record<string, unknown>): CommandCodeEndpointMetadata {
  return {
    reasoning: parseField(record, "reasoning", (value) =>
      typeof value === "boolean" ? value : undefined,
    ),
    reasoningOptions: parseField(record, "reasoning_options", parseReasoningOptions),
    outputLimit: parseOutputLimit(record),
    temperature: parseField(record, "temperature", (value) =>
      typeof value === "boolean" ? value : undefined,
    ),
    toolCall: parseField(record, "tool_call", (value) =>
      typeof value === "boolean" ? value : undefined,
    ),
    releaseDate: parseReleaseDate(record),
  };
}

export function decodeCommandCodeCatalog(payload: unknown): CommandCodeCatalog {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("CommandCode model catalog has an invalid response shape");
  }

  const items: CommandCodeCatalogItem[] = [];
  for (const value of payload.data) {
    if (!isRecord(value)) continue;

    const rawId = value.id;
    const contextLength = value.context_length;
    if (
      typeof rawId !== "string" ||
      !isModelId(rawId) ||
      typeof contextLength !== "number" ||
      !Number.isFinite(contextLength) ||
      contextLength <= 0
    ) {
      continue;
    }

    const id = makeModelId(rawId);
    const name = typeof value.name === "string" && value.name.length > 0 ? value.name : id;
    const created = optionalNumber(value, "created");
    const endpoint = readEndpointMetadata(value);
    const hasEndpointMetadata = Object.values(endpoint).some((field) => field.state !== "absent");
    items.push({
      id,
      name,
      contextLength,
      ...(created === undefined ? {} : { created }),
      ...(hasEndpointMetadata ? { endpoint } : {}),
    });
  }

  if (items.length === 0) {
    throw new Error("CommandCode model catalog contains no usable models");
  }

  return items;
}

function endpointValue<T>(field: EndpointField<T>, staticValue: T | undefined): T | undefined {
  if (field.state === "known") return field.value;
  if (field.state === "blocked") return undefined;
  return staticValue;
}

function endpointValueOrDefault<T>(
  field: EndpointField<T>,
  staticValue: T | undefined,
  defaultValue: T,
  blockedValue: T,
): T {
  if (field.state === "known") return field.value;
  if (field.state === "blocked") return blockedValue;
  return staticValue ?? defaultValue;
}

function releaseDateFromCreated(created: number | undefined): string | undefined {
  if (created === undefined) return undefined;
  const date = new Date(created * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

export function toCommandCodeModelConfig(
  item: CommandCodeCatalogItem,
  staticMetadata: StaticModelMetadata | undefined = undefined,
): CommandCodeOpenCodeModel {
  const endpoint = item.endpoint ?? {
    reasoning: absent<boolean>(),
    reasoningOptions: absent<ReasoningOptions>(),
    outputLimit: absent<number>(),
    temperature: absent<boolean>(),
    toolCall: absent<boolean>(),
    releaseDate: absent<string>(),
  };
  const reasoning = endpointValueOrDefault(
    endpoint.reasoning,
    staticMetadata?.reasoning,
    true,
    false,
  );
  const temperature = endpointValueOrDefault(
    endpoint.temperature,
    staticMetadata?.temperature,
    true,
    false,
  );
  const toolCall = endpointValueOrDefault(
    endpoint.toolCall,
    staticMetadata?.toolCall,
    true,
    false,
  );
  const reasoningOptions = endpointValue(
    endpoint.reasoningOptions,
    staticMetadata?.reasoningOptions,
  );
  const releaseDate =
    endpoint.releaseDate.state === "blocked"
      ? undefined
      : (endpointValue(endpoint.releaseDate, staticMetadata?.releaseDate) ??
        releaseDateFromCreated(item.created));
  const outputLimit = endpointValueOrDefault(
    endpoint.outputLimit,
    staticMetadata?.outputLimit,
    DEFAULT_OUTPUT_LIMIT,
    DEFAULT_OUTPUT_LIMIT,
  );
  const endpointVariants =
    endpoint.reasoningOptions.state === "known"
      ? toOpenCodeVariants(endpoint.reasoningOptions.value)
      : undefined;
  const effectiveReasoning =
    endpoint.reasoning.state === "absent" && endpointVariants !== undefined
      ? true
      : reasoning;
  const variants = effectiveReasoning ? toOpenCodeVariants(reasoningOptions) : undefined;
  const vision = staticMetadata?.vision !== false;

  return {
    id: item.id,
    name: item.name || item.id,
    ...(releaseDate === undefined ? {} : { release_date: releaseDate }),
    attachment: vision,
    reasoning: effectiveReasoning,
    temperature,
    tool_call: toolCall,
    cost: {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    },
    limit: { context: item.contextLength, output: outputLimit },
    modalities: {
      input: vision ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    status: "active",
    options: {},
    headers: {},
    ...(variants === undefined ? {} : { variants }),
  };
}

function installModels(
  config: Config,
  models: Readonly<Record<string, CommandCodeOpenCodeModel>>,
): void {
  const providerModels = models as NonNullable<NonNullable<Config["provider"]>[string]["models"]>;
  const existing = config.provider?.commandcode;
  config.provider = {
    ...config.provider,
    commandcode: {
      ...existing,
      name: "Command Code",
      npm: "@falentio/opencode-commandcode",
      api: COMMAND_CODE_ALPHA_URL,
      models: providerModels,
    },
  };
}

export function installCommandCodeProvider(
  config: Config,
  catalog: CommandCodeCatalog,
  lookup: StaticModelMetadataLookup = lookupStaticModelMetadata,
): void {
  const models = Object.fromEntries(
    catalog.map((item) => [item.id, toCommandCodeModelConfig(item, lookup(item.id))]),
  );
  installModels(config, models);
}

export async function fetchCommandCodeCatalog(fetcher: FetchLike): Promise<CommandCodeCatalog> {
  const response = await fetcher(COMMAND_CODE_CATALOG_URL, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`CommandCode model catalog request failed with HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  return decodeCommandCodeCatalog(payload);
}
