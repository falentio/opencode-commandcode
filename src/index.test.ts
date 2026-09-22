import { describe, expect, it } from "vitest";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { IntegrationMethodRegistration } from "@opencode/plugin/promise/integration";
import type { ProviderEditor } from "@opencode/plugin/promise/provider";
import type { Model } from "@opencode/schema/model";
import type { Provider } from "@opencode/schema/provider";
import {
  COMMAND_CODE_INTEGRATION_ID,
  COMMAND_CODE_PROVIDER_ID,
  COMMAND_CODE_PROVIDER_PACKAGE,
  commandCodePlugin,
} from "./index.js";
import type { CommandCodeCatalog } from "./catalog.js";
import type { CommandCodeProxy, CommandCodeProxyOptions } from "./runtime.js";

const catalog: CommandCodeCatalog = [
  {
    id: "gpt-5.5" as CommandCodeCatalog[number]["id"],
    name: "GPT-5.5",
    contextLength: 1000000,
    created: 1789549210,
    endpoint: {
      reasoning: { state: "absent" },
      reasoningOptions: { state: "known", value: [{ type: "effort", values: ["low", "high"] }] },
      outputLimit: { state: "absent" },
      temperature: { state: "absent" },
      toolCall: { state: "absent" },
      releaseDate: { state: "absent" },
    },
  },
];

type Recorded = {
  providers: Array<{ info: Provider.Info; models: Model.Info[] }>;
  methods: IntegrationMethodRegistration[];
  names: string[];
  order: string[];
};

function makeContext(recorded: Recorded, apiKey: string | undefined): Context {
  const providerDraft = {
    list: () => [],
    get: () => undefined,
    add: (input: { info: Provider.Info; models: readonly Model.Info[] }) => {
      recorded.order.push("provider.add");
      recorded.providers.push({ info: input.info, models: [...input.models] });
    },
    update: () => undefined,
    remove: () => undefined,
    models: { set: () => undefined, update: () => undefined, remove: () => undefined },
  } satisfies ProviderEditor;

  const integrationDraft = {
    list: () => [],
    get: () => undefined,
    update: (id: string, update: (integration: { id: string; name: string }) => void) => {
      const ref = { id, name: id };
      update(ref);
      recorded.names.push(ref.name);
    },
    remove: () => undefined,
    method: {
      list: () => [],
      update: (input: IntegrationMethodRegistration) => {
        recorded.methods.push(input);
      },
      remove: () => undefined,
    },
  };

  const context = {
    provider: {
      transform: async (callback: (draft: ProviderEditor) => void) => {
        recorded.order.push("provider.transform");
        callback(providerDraft);
        return { dispose: async () => undefined };
      },
    },
    integration: {
      transform: async (callback: (draft: unknown) => void) => {
        recorded.order.push("integration.transform");
        callback(integrationDraft);
        return { dispose: async () => undefined };
      },
      connection: {
        active: async () =>
          apiKey === undefined ? undefined : ({ type: "credential", id: "c1", label: "k" } as never),
        resolve: async () => (apiKey === undefined ? undefined : ({ type: "key", key: apiKey } as never)),
      },
    },
  };

  return context as unknown as Context;
}

function makeStartProxy(port: number, recorded?: Recorded) {
  return async (options?: CommandCodeProxyOptions): Promise<CommandCodeProxy> => {
    recorded?.order.push("proxy.start");
    proxyCalls.push(options);
    return { port, baseURL: `http://127.0.0.1:${port}/v1`, close: async () => undefined };
  };
}

let proxyCalls: Array<CommandCodeProxyOptions | undefined> = [];

function resetProxyCalls(): void {
  proxyCalls = [];
}

describe("commandCodePlugin", () => {
  it("registers the bundled provider package with one model per catalog entry", async () => {
    resetProxyCalls();
    const recorded: Recorded = { providers: [], methods: [], names: [], order: [] };
    const plugin = commandCodePlugin({
      fetchCatalog: async () => catalog,
      startProxy: makeStartProxy(41234),
    });

    await plugin.setup(makeContext(recorded, undefined));

    expect(recorded.providers).toHaveLength(1);
    const [registered] = recorded.providers;
    expect(registered?.info).toEqual({
      id: COMMAND_CODE_PROVIDER_ID,
      name: "Command Code",
      activation: "enabled",
      package: COMMAND_CODE_PROVIDER_PACKAGE,
      integrationID: COMMAND_CODE_INTEGRATION_ID,
    });
    expect(registered?.models).toHaveLength(1);
    expect(registered?.models[0]).toMatchObject({
      id: "gpt-5.5",
      modelID: "gpt-5.5",
      providerID: "commandcode",
      name: "GPT-5.5",
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      variants: [
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "high", settings: { reasoningEffort: "high" } },
      ],
      status: "active",
      enabled: true,
      limit: { context: 1000000, output: 128000 },
      settings: { baseURL: "http://127.0.0.1:41234/v1" },
    });
  });

  it("starts the proxy before registering transforms and closes it on cleanup", async () => {
    resetProxyCalls();
    const recorded: Recorded = { providers: [], methods: [], names: [], order: [] };
    let closed = false;
    const plugin = commandCodePlugin({
      fetchCatalog: async () => {
        recorded.order.push("catalog");
        return catalog;
      },
      startProxy: async (options?: CommandCodeProxyOptions) => {
        void options;
        recorded.order.push("proxy.start");
        return {
          port: 1,
          baseURL: "http://127.0.0.1:1/v1",
          close: async () => {
            closed = true;
          },
        };
      },
    });

    const cleanup = await plugin.setup(makeContext(recorded, undefined));

    expect(recorded.order).toEqual([
      "catalog",
      "proxy.start",
      "provider.transform",
      "provider.add",
      "integration.transform",
    ]);
    expect(closed).toBe(false);
    await cleanup?.();
    expect(closed).toBe(true);
  });

  it("registers an API-key method so /connect can store the key", async () => {
    resetProxyCalls();
    const recorded: Recorded = { providers: [], methods: [], names: [], order: [] };
    const plugin = commandCodePlugin({
      fetchCatalog: async () => catalog,
      startProxy: makeStartProxy(1),
    });

    await plugin.setup(makeContext(recorded, "user_test"));

    expect(recorded.methods).toEqual([
      {
        integrationID: COMMAND_CODE_INTEGRATION_ID,
        method: { type: "key", label: "API key" },
      },
    ]);
    expect(recorded.names).toEqual(["Command Code"]);
    expect(proxyCalls[0]?.resolveApiKey).toBeTypeOf("function");
  });

  it("still registers the provider when the catalog fetch fails", async () => {
    resetProxyCalls();
    const recorded: Recorded = { providers: [], methods: [], names: [], order: [] };
    const plugin = commandCodePlugin({
      fetchCatalog: async () => {
        throw new Error("offline");
      },
      startProxy: makeStartProxy(1),
    });

    await plugin.setup(makeContext(recorded, undefined));

    expect(recorded.providers).toHaveLength(1);
    expect(recorded.providers[0]?.models).toEqual([]);
  });

  it("reads the API key from the active integration connection", async () => {
    resetProxyCalls();
    const recorded: Recorded = { providers: [], methods: [], names: [], order: [] };
    const plugin = commandCodePlugin({
      fetchCatalog: async () => catalog,
      startProxy: makeStartProxy(1),
    });
    await plugin.setup(makeContext(recorded, "user_from_integration"));

    const resolveApiKey = proxyCalls[0]?.resolveApiKey;
    expect(resolveApiKey).toBeTypeOf("function");
    await expect(resolveApiKey?.()).resolves.toBe("user_from_integration");
  });

  it("resolves no API key when the integration has no active connection", async () => {
    resetProxyCalls();
    const recorded: Recorded = { providers: [], methods: [], names: [], order: [] };
    const plugin = commandCodePlugin({
      fetchCatalog: async () => catalog,
      startProxy: makeStartProxy(1),
    });
    await plugin.setup(makeContext(recorded, undefined));

    await expect(proxyCalls[0]?.resolveApiKey?.()).resolves.toBeUndefined();
  });

  it("exposes a default export shaped like a v2 plugin", async () => {
    const entry = (await import("./index.js")).default;
    expect(entry.id).toBe("commandcode");
    expect(entry.setup).toBeTypeOf("function");
  });

  it("declares the provider ID and integration ID the docs promise", () => {
    expect(COMMAND_CODE_PROVIDER_ID).toBe("commandcode");
    expect(COMMAND_CODE_INTEGRATION_ID).toBe("commandcode");
    expect(COMMAND_CODE_PROVIDER_PACKAGE).toBe("@opencode/ai/providers/openai-compatible");
  });
});
