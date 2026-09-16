import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "@opencode-ai/plugin";
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
              id: "moonshotai/Kimi-K2.6",
              name: "Kimi K2.6",
              context_length: 256000,
              created: 1789549210,
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
      "moonshotai/Kimi-K2.6": expect.objectContaining({
        id: "moonshotai/Kimi-K2.6",
        name: "Kimi K2.6",
        limit: { context: 256000, output: 64000 },
        reasoning: true,
        tool_call: true,
      }),
    });
  });
});
