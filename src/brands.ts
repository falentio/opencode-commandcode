import type { Integration } from "@opencode/schema/integration";
import type { Model } from "@opencode/schema/model";
import type { Provider } from "@opencode/schema/provider";

export type ModelID = Model.Info["id"];
export type ModelVariantID = Model.Info["variants"][number]["id"];
export type ProviderID = Provider.Info["id"];
export type IntegrationID = Integration.Info["id"];
export type Money = Model.Info["cost"][number]["input"];

// `effect` `Schema.brand` values are nominal only in the type system: at runtime
// every one of them is the plain value it wraps. opencode's plugin runtime
// cannot resolve this package's `@opencode/schema` dependency for a bare
// specifier, so the brands are reattached here instead of via `Schema.make`.
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
