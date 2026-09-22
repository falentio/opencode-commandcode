import type { Context, Plugin } from "@opencode/plugin/promise/plugin";
import { integrationID, providerID } from "./brands.js";
import {
  fetchCommandCodeCatalog,
  toCommandCodeModelConfigs,
  type CommandCodeCatalog,
} from "./catalog.js";
import { lookupStaticModelMetadata } from "./model-metadata.js";
import { startCommandCodeProxy } from "./runtime.js";

export const COMMAND_CODE_INTEGRATION_ID = "commandcode";
export const COMMAND_CODE_PROVIDER_ID = "commandcode";
// opencode accepts a `LanguageModel` only from its own bundled provider runtime.
// Any other specifier yields one built from a foreign module instance, which
// opencode rejects while resolving the model.
export const COMMAND_CODE_PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible";

export type CommandCodePluginDependencies = {
  fetchCatalog?: typeof fetchCommandCodeCatalog;
  startProxy?: typeof startCommandCodeProxy;
};

async function activeApiKey(context: Context): Promise<string | undefined> {
  const connection = await context.integration.connection.active(
    integrationID(COMMAND_CODE_INTEGRATION_ID),
  );
  if (!connection) return undefined;
  const credential = await context.integration.connection.resolve(connection);
  if (!credential) return undefined;
  return "key" in credential && typeof credential.key === "string" && credential.key.length > 0
    ? credential.key
    : undefined;
}

export function commandCodePlugin(dependencies: CommandCodePluginDependencies = {}): Plugin {
  const fetchCatalog = dependencies.fetchCatalog ?? fetchCommandCodeCatalog;
  const startProxy = dependencies.startProxy ?? startCommandCodeProxy;

  return {
    id: "commandcode",
    async setup(context: Context) {
      let catalog: CommandCodeCatalog | undefined;
      try {
        catalog = await fetchCatalog(fetch);
      } catch {
        catalog = undefined;
      }

      const proxy = await startProxy({
        catalog,
        resolveApiKey: () => activeApiKey(context),
      });

      try {
        await context.provider.transform((draft) => {
          draft.add({
            info: {
              id: providerID(COMMAND_CODE_PROVIDER_ID),
              name: "Command Code",
              activation: "enabled",
              package: COMMAND_CODE_PROVIDER_PACKAGE,
              integrationID: integrationID(COMMAND_CODE_INTEGRATION_ID),
            },
            models: toCommandCodeModelConfigs(
              catalog ?? [],
              proxy.baseURL,
              lookupStaticModelMetadata,
            ),
          });
        });

        await context.integration.transform((draft) => {
          const id = integrationID(COMMAND_CODE_INTEGRATION_ID);
          draft.update(id, (integration) => {
            if (integration.name === COMMAND_CODE_INTEGRATION_ID) integration.name = "Command Code";
          });
          draft.method.update({
            integrationID: id,
            method: { type: "key", label: "API key" },
          });
        });
      } catch (error) {
        // The listener is already bound and opencode only registers the release
        // after setup resolves, so nothing else can dispose of it.
        await proxy.close().catch(() => undefined);
        throw error;
      }

      return async () => {
        await proxy.close();
      };
    },
  };
}

export default commandCodePlugin();
