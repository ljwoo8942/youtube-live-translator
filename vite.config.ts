import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "validate-content-script-bundle",
      generateBundle(_options, bundle) {
        const contentScript = bundle["content.js"];
        if (!contentScript || contentScript.type !== "chunk") {
          throw new Error("content.js was not generated.");
        }
        if (contentScript.imports.length > 0 || contentScript.dynamicImports.length > 0) {
          throw new Error("Chrome content.js must be self-contained and cannot import other chunks.");
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
        content: "src/content/index.ts",
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
