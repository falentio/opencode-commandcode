import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    dts: true,
    exports: {
      customExports: {
        "./server": "./dist/index.mjs",
      },
    },
    sourcemap: true,
  },
});
