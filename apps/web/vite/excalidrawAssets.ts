// @effect-diagnostics-next-line nodeBuiltinImport:off -- Vite config runs before any Effect runtime.
import * as NodeFSP from "node:fs/promises";
import type { Plugin } from "vite-plus";

const ASSET_PREFIX = "assets/excalidraw/fonts/";
const fontsDirectory = new URL("./fonts/", import.meta.resolve("@excalidraw/excalidraw"));

async function fontFiles() {
  const fonts = new Map<string, URL>();
  for await (const file of NodeFSP.glob("**/*.woff2", { cwd: fontsDirectory })) {
    const path = file.replaceAll("\\", "/");
    fonts.set(`${ASSET_PREFIX}${path}`, new URL(path, fontsDirectory));
  }
  return fonts;
}

export function excalidrawAssetsPlugin(): Plugin {
  return {
    name: "t3code:excalidraw-fonts",
    async configureServer(server) {
      const fonts = await fontFiles();
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?", 1)[0];
        const base = server.config.base;
        const font = path?.startsWith(base) ? fonts.get(path.slice(base.length)) : undefined;
        if (!font) return next();
        void NodeFSP.readFile(font).then((bytes) => {
          response.setHeader("Content-Type", "font/woff2");
          response.end(bytes);
        }, next);
      });
    },
    async generateBundle() {
      for (const [fileName, url] of await fontFiles()) {
        this.emitFile({ type: "asset", fileName, source: await NodeFSP.readFile(url) });
      }
    },
  };
}
