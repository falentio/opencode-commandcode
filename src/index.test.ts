import { describe, expect, it, vi } from "vitest";
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

describe("CommandCodePlugin", () => {
  it("logs on init and returns hooks", async () => {
    const client = makeClient();
    const hooks = await CommandCodePlugin(makeContext(client));

    expect(client.app.log).toHaveBeenCalledOnce();
    expect(hooks.tool?.commandcode).toBeDefined();
    expect(hooks.event).toBeTypeOf("function");
  });

  it("exposes a commandcode tool that echoes the command", async () => {
    const client = makeClient();
    const hooks = await CommandCodePlugin(makeContext(client));
    const tool = hooks.tool?.commandcode;

    expect(tool).toBeDefined();
    const result = await tool!.execute(
      { command: "hello" },
      { directory: "/tmp/project", worktree: "/tmp/project" } as never,
    );

    expect(result).toBe("commandcode: hello (/tmp/project)");
  });
});
