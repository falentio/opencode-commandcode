import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "@opencode-ai/plugin";
import packageManifest from "../package.json";
import { CommandCodePlugin } from "./index.js";

const makeClient = () => ({
  app: { log: vi.fn().mockResolvedValue(undefined) },
});

const makeContext = (client: ReturnType<typeof makeClient>) =>
  ({
    client,
    directory: "/tmp/project",
    worktree: "/tmp/project",
    project: {},
    $: vi.fn(),
  }) as never;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CommandCodePlugin", () => {
  it("exposes the server entrypoint required by OpenCode's plugin installer", () => {
    expect(packageManifest.exports).toMatchObject({ "./server": "./dist/index.mjs" });
  });

  it("exposes API-key auth without prompts or authorize logic", async () => {
    const hooks = await CommandCodePlugin(makeContext(makeClient()));

    expect(hooks.auth).toEqual({
      provider: "commandcode",
      methods: [{ type: "api", label: "API key" }],
    });
    expect(hooks.config).toBeTypeOf("function");
  });

  it("installs the live model catalog during config loading", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "gpt-5.5",
              name: "GPT-5.5",
              context_length: 1000000,
              created: 1789549210,
              reasoning_options: [{ type: "effort", values: ["low", "high"] }],
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetcher);

    const hooks = await CommandCodePlugin(makeContext(makeClient()));
    const config: Config = {
      provider: {
        commandcode: { options: { timeout: 120000 } },
      },
    };

    await hooks.config?.(config);

    expect(fetcher).toHaveBeenCalledWith("https://api.commandcode.ai/provider/v1/models", {
      headers: { Accept: "application/json" },
    });
    expect(config.provider?.commandcode).toMatchObject({
      name: "Command Code",
      npm: "@falentio/opencode-commandcode",
      api: "https://api.commandcode.ai/alpha/generate",
      options: { timeout: 120000 },
    });
    expect(config.provider?.commandcode?.models).toEqual({
      "gpt-5.5": expect.objectContaining({
        id: "gpt-5.5",
        name: "GPT-5.5",
        limit: { context: 1000000, output: 128000 },
        reasoning: true,
        tool_call: true,
        variants: {
          low: { reasoningEffort: "low" },
          high: { reasoningEffort: "high" },
        },
      }),
    });
  });
});
