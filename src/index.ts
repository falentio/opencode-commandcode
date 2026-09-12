import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

export const CommandCodePlugin: Plugin = async ({ client, directory }) => {
  await client.app.log({
    body: {
      service: "@falentio/opencode-commandcode",
      level: "info",
      message: "CommandCode plugin initialized",
      extra: { directory },
    },
  });

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await client.app.log({
          body: {
            service: "@falentio/opencode-commandcode",
            level: "debug",
            message: "Session idle",
          },
        });
      }
    },

    tool: {
      commandcode: tool({
        description: "Run a CommandCode command",
        args: {
          command: tool.schema.string().describe("The command to run"),
        },
        async execute(args, context) {
          return `commandcode: ${args.command} (${context.directory})`;
        },
      }),
    },
  };
};
