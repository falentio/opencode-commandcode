import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("model metadata generator", () => {
  it("renders deterministically, follows provider preference, and reports unmatched IDs", () => {
    const directory = mkdtempSync(join(tmpdir(), "commandcode-model-metadata-"));
    try {
      const modelsDev = join(directory, "models-api.json");
      const commandCode = join(directory, "commandcode-models.json");
      const firstOutput = join(directory, "first.ts");
      const secondOutput = join(directory, "second.ts");
      writeFileSync(
        modelsDev,
        JSON.stringify({
          opencode: {
            models: {
              plain: {
                reasoning: true,
                reasoning_options: [{ type: "effort", values: ["low", "high"] }],
                temperature: false,
                tool_call: true,
                limit: { output: 128000 },
                release_date: "2026-01-01",
              },
              sight: {
                limit: { output: 1000 },
                modalities: { input: ["text", "image"], output: ["text"] },
              },
              blind: {
                limit: { output: 1000 },
                modalities: { input: ["text"], output: ["text"] },
              },
              broken: {
                limit: { output: 1000 },
                modalities: { input: "text" },
              },
            },
          },
          openrouter: {
            models: {
              "vendor/model": {
                reasoning: false,
                reasoning_options: [],
                limit: { output: 64000 },
                temperature: true,
                tool_call: false,
              },
            },
          },
          openai: {
            models: {
              plain: { outputLimit: 1 },
              "fallback/model": { limit: { output: 32000 } },
            },
          },
        }),
      );
      writeFileSync(
        commandCode,
        JSON.stringify({
          data: [
            { id: "vendor/model" },
            { id: "plain" },
            { id: "fallback/model" },
            { id: "sight" },
            { id: "blind" },
            { id: "broken" },
            { id: "missing" },
          ],
        }),
      );

      const args = [
        "scripts/generate-model-metadata.mjs",
        "--models-dev",
        modelsDev,
        "--commandcode",
        commandCode,
      ];
      const output = execFileSync(process.execPath, [...args, "--out", firstOutput], {
        encoding: "utf8",
      });
      execFileSync(process.execPath, [...args, "--out", secondOutput], { encoding: "utf8" });

      expect(readFileSync(firstOutput, "utf8")).toBe(readFileSync(secondOutput, "utf8"));
      expect(output).toContain("Unmatched IDs: broken, missing");
      expect(readFileSync(firstOutput, "utf8")).toContain(
        '"plain": {"sourceProvider":"opencode"',
      );
      expect(readFileSync(firstOutput, "utf8")).toContain(
        '"vendor/model": {"sourceProvider":"openrouter"',
      );
      expect(readFileSync(firstOutput, "utf8")).toContain(
        '"fallback/model": {"sourceProvider":"openai"',
      );
      expect(readFileSync(firstOutput, "utf8")).not.toContain("cost");
      expect(readFileSync(firstOutput, "utf8")).not.toContain("modalities");
      expect(readFileSync(firstOutput, "utf8")).toContain('"outputLimit":128000');
      expect(readFileSync(firstOutput, "utf8")).toContain('"sight": {"sourceProvider":"opencode"');
      expect(readFileSync(firstOutput, "utf8")).toContain('"vision":true');
      expect(readFileSync(firstOutput, "utf8")).toContain('"vision":false');
      expect(readFileSync(firstOutput, "utf8")).not.toContain('"broken"');
      expect(output).toContain("broken");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
