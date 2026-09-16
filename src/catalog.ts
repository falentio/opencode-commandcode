import type { Config } from "@opencode-ai/plugin";

export const COMMAND_CODE_CATALOG_URL = "https://api.commandcode.ai/provider/v1/models";
export const COMMAND_CODE_ALPHA_URL = "https://api.commandcode.ai/alpha/generate";

export type FetchLike = typeof fetch;

export type ModelId = string & {
  readonly __brand: "CommandCodeModelId";
};

export type CommandCodeCatalogItem = {
  id: ModelId;
  name: string;
  contextLength: number;
  created?: number;
};

export type CommandCodeCatalog = readonly CommandCodeCatalogItem[];

type OpenCodeModelConfig = NonNullable<
  NonNullable<NonNullable<Config["provider"]>[string]["models"]>[string]
>;

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

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
    const created = readOptionalNumber(value, "created");
    items.push({
      id,
      name,
      contextLength,
      ...(created === undefined ? {} : { created }),
    });
  }

  if (items.length === 0) {
    throw new Error("CommandCode model catalog contains no usable models");
  }

  return items;
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

function releaseDate(created: number | undefined): string | undefined {
  if (created === undefined) return undefined;
  const date = new Date(created * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

export function toCommandCodeModelConfig(item: CommandCodeCatalogItem): OpenCodeModelConfig {
  const date = releaseDate(item.created);
  return {
    id: item.id,
    name: item.name || item.id,
    ...(date === undefined ? {} : { release_date: date }),
    attachment: false,
    reasoning: true,
    temperature: true,
    tool_call: true,
    cost: {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    },
    limit: {
      context: item.contextLength,
      output: 64000,
    },
    modalities: {
      input: ["text"],
      output: ["text"],
    },
    status: "active",
    options: {},
    headers: {},
  };
}

export function installCommandCodeProvider(config: Config, catalog: CommandCodeCatalog): void {
  const existing = config.provider?.commandcode;
  config.provider = {
    ...config.provider,
    commandcode: {
      ...existing,
      name: "Command Code",
      npm: "@falentio/opencode-commandcode",
      api: COMMAND_CODE_ALPHA_URL,
      models: Object.fromEntries(catalog.map((item) => [item.id, toCommandCodeModelConfig(item)])),
    },
  };
}
