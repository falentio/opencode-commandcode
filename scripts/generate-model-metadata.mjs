import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_OUTPUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/models-dev.generated.ts",
);
const FALLBACK_PROVIDERS = [
  "openrouter",
  "opencode",
  "openai",
  "anthropic",
  "google",
  "pioneer",
  "deepinfra",
  "huggingface",
  "togetherai",
  "nebius",
  "baseten",
  "vercel",
  "kilo",
  "nvidia",
  "siliconflow",
  "merge-gateway",
  "edenai",
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function normalizeReasoningOptions(value) {
  if (value === null) return [];
  if (!Array.isArray(value)) return undefined;

  const options = [];
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
          (item) => typeof item !== "string" || item.length === 0 || item.trim() !== item,
        )
      ) {
        return undefined;
      }
      options.push({ type: "effort", values: [...new Set(option.values)] });
      continue;
    }
    if (option.type === "budget_tokens") {
      const min = finiteNumber(option.min);
      const max = finiteNumber(option.max);
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

function outputLimit(value) {
  if (!isRecord(value)) return undefined;

  if (Object.hasOwn(value, "limit")) {
    if (!isRecord(value.limit)) return undefined;
    if (Object.hasOwn(value.limit, "output")) return positiveNumber(value.limit.output);
  }

  return positiveNumber(value.max_output_tokens);
}

function normalizeMetadata(value, sourceProvider) {
  if (!isRecord(value)) return undefined;
  const metadata = { sourceProvider };

  if (Object.hasOwn(value, "reasoning")) {
    if (typeof value.reasoning !== "boolean") return undefined;
    metadata.reasoning = value.reasoning;
  }

  if (Object.hasOwn(value, "reasoning_options")) {
    const reasoningOptions = normalizeReasoningOptions(value.reasoning_options);
    if (reasoningOptions === undefined) return undefined;
    metadata.reasoningOptions = reasoningOptions;
  }

  if (Object.hasOwn(value, "limit") && !isRecord(value.limit)) return undefined;
  if (
    isRecord(value.limit) &&
    Object.hasOwn(value.limit, "output") &&
    outputLimit(value) === undefined
  ) {
    return undefined;
  }
  if (
    Object.hasOwn(value, "max_output_tokens") &&
    positiveNumber(value.max_output_tokens) === undefined
  ) {
    return undefined;
  }
  const output = outputLimit(value);
  if (output !== undefined) metadata.outputLimit = output;

  if (Object.hasOwn(value, "temperature")) {
    if (typeof value.temperature !== "boolean") return undefined;
    metadata.temperature = value.temperature;
  }

  if (Object.hasOwn(value, "tool_call")) {
    if (typeof value.tool_call !== "boolean") return undefined;
    metadata.toolCall = value.tool_call;
  }

  if (Object.hasOwn(value, "release_date")) {
    if (typeof value.release_date !== "string" || value.release_date.length === 0) return undefined;
    metadata.releaseDate = value.release_date;
  }

  return metadata;
}

function providerRows(payload, wantedIds) {
  if (!isRecord(payload)) throw new Error("models.dev snapshot has an invalid response shape");

  const directRows = Object.entries(payload).filter(
    ([id, value]) => wantedIds.has(id) && isRecord(value) && !Object.hasOwn(value, "models"),
  );
  if (directRows.length > 0) return [["snapshot", Object.fromEntries(directRows)]];

  if (isRecord(payload.models)) return [["models", payload.models]];

  return Object.entries(payload)
    .filter(([, provider]) => isRecord(provider) && isRecord(provider.models))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, value]) => [provider, value.models]);
}

function providerOrder(id) {
  const preferred = id.includes("/") ? "openrouter" : "opencode";
  return [...new Set([preferred, ...FALLBACK_PROVIDERS])];
}

function metadataRows(payload, wantedIds) {
  const providers = new Map(providerRows(payload, wantedIds));
  const rows = new Map();

  for (const id of wantedIds) {
    for (const provider of providerOrder(id)) {
      const model = providers.get(provider)?.[id];
      if (!isRecord(model)) continue;
      const metadata = normalizeMetadata(model, provider);
      if (metadata !== undefined) {
        rows.set(id, metadata);
        break;
      }
    }
  }

  return rows;
}

function commandCodeModelIds(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("CommandCode snapshot has an invalid response shape");
  }

  const ids = new Set();
  for (const model of payload.data) {
    if (!isRecord(model) || typeof model.id !== "string" || model.id.trim() !== model.id) continue;
    if (model.id.length > 0) ids.add(model.id);
  }
  if (ids.size === 0) throw new Error("CommandCode snapshot contains no usable model IDs");
  return [...ids].sort();
}

export function generateModelMetadata(modelsDevPayload, commandCodePayload) {
  const ids = commandCodeModelIds(commandCodePayload);
  const rows = metadataRows(modelsDevPayload, new Set(ids));
  const models = {};
  const unmatched = [];
  for (const id of ids) {
    const metadata = rows.get(id);
    if (metadata === undefined) {
      unmatched.push(id);
      continue;
    }
    models[id] = metadata;
  }
  return { models, unmatched };
}

export function renderGeneratedFile(models) {
  const entries = Object.keys(models)
    .sort()
    .map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(models[id])},`)
    .join("\n");
  return `import type { StaticModelMetadataTable } from "./model-metadata.js";\n\nexport const COMMAND_CODE_MODEL_METADATA: StaticModelMetadataTable = {\n${entries}\n} satisfies StaticModelMetadataTable;\n`;
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function main(args) {
  const modelsDevFile = argumentValue(args, "--models-dev");
  const commandCodeFile = argumentValue(args, "--commandcode");
  const outputFile = argumentValue(args, "--out") ?? DEFAULT_OUTPUT;
  if (!modelsDevFile || !commandCodeFile) {
    throw new Error(
      "Usage: node scripts/generate-model-metadata.mjs --models-dev <file> --commandcode <file> [--out <file>]",
    );
  }

  const { models, unmatched } = generateModelMetadata(
    readJson(modelsDevFile),
    readJson(commandCodeFile),
  );
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, renderGeneratedFile(models));
  process.stdout.write(
    `Generated ${Object.keys(models).length} metadata rows at ${outputFile}.\n` +
      (unmatched.length === 0 ? "No unmatched CommandCode model IDs.\n" : `Unmatched IDs: ${unmatched.join(", ")}\n`),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
