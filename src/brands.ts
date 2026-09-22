import type { Integration } from "@opencode/schema/integration";
import type { Model } from "@opencode/schema/model";
import type { Provider } from "@opencode/schema/provider";

export type ModelID = Model.Info["id"];
export type ModelVariantID = Model.Info["variants"][number]["id"];
export type ProviderID = Provider.Info["id"];
export type IntegrationID = Integration.Info["id"];
export type Money = Model.Info["cost"][number]["input"];

// `effect` `Schema.brand` values are nominal only in the type system: at runtime
// every one of them is the plain value it wraps. The brands are reattached here
// rather than through `Schema.make` so the built plugin keeps importing nothing
// but node builtins, and therefore needs no bare specifier to resolve at load
// time. See AGENTS.md for the constraint this protects.
export function modelID(value: string): ModelID {
  return value as ModelID;
}

export function modelVariantID(value: string): ModelVariantID {
  return value as ModelVariantID;
}

export function providerID(value: string): ProviderID {
  return value as ProviderID;
}

export function integrationID(value: string): IntegrationID {
  return value as IntegrationID;
}

export function money(value: number): Money {
  return value as Money;
}
