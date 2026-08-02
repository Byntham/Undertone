import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rendererRoot = fileURLToPath(new URL("./src/renderer", import.meta.url));

export default defineConfig({
  root: rendererRoot,
  base: "./",
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: false,
    rollupOptions: {
      input: {
        settings: path.join(rendererRoot, "index.html"),
        overlay: path.join(rendererRoot, "overlay/index.html"),
      },
    },
  },
});
