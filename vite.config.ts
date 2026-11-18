import { build, defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "bundle-content-script",
      async generateBundle() {
        // Chrome injects content scripts as classic scripts, without shared chunks.
        const result = await build({
          configFile: false,
          publicDir: false,
          logLevel: "error",
          build: {
            write: false,
            sourcemap: true,
            rollupOptions: {
              input: "src/content/index.ts",
              output: { format: "iife", inlineDynamicImports: true, entryFileNames: "content.js" }
            }
          }
        });
        if (!("output" in result)) throw new Error("content.js was not generated.");
        const contentScript = result.output.find((file) => file.fileName === "content.js");
        if (!contentScript || contentScript.type !== "chunk") {
          throw new Error("content.js was not generated.");
        }
        if (contentScript.imports.length > 0 || contentScript.dynamicImports.length > 0) {
          throw new Error("Chrome content.js must be self-contained and cannot import other chunks.");
        }
        for (const file of result.output) {
          this.emitFile({ type: "asset", fileName: file.fileName, source: file.type === "chunk" ? file.code : file.source });
        }
      }
    }
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        background: "src/background/index.ts",
        offscreen: "offscreen.html",
        popup: "popup.html",
        options: "options.html",
        corrections: "corrections.html"
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
