import type { AuthHook, Config, Hooks, Plugin } from "@opencode-ai/plugin";
import { fetchCommandCodeCatalog, installCommandCodeProvider } from "./catalog.js";

export { createCommandCode } from "./runtime.js";

function commandCodeAuth(): AuthHook {
  return {
    provider: "commandcode",
    methods: [{ type: "api", label: "API key" }],
  };
}

async function installProvider(config: Config): Promise<void> {
  const catalog = await fetchCommandCodeCatalog(fetch);
  installCommandCodeProvider(config, catalog);
}

export const CommandCodePlugin: Plugin = async (): Promise<Hooks> => {
  return {
    auth: commandCodeAuth(),
    config: installProvider,
  };
};
