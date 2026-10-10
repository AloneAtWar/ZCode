import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const HERE = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // 与 packages/web 相同：@zcode/ui 以源码形式被消费，需要 @ -> packages/ui/src。
      "@": resolve(HERE, "../../packages/ui/src"),
      // Recharts 依赖 d3-shape@3.x；固定解析到根部 d3-path@3.x 入口（同 packages/web）。
      "d3-path": resolve(HERE, "../../node_modules/d3-path/src/index.js"),
    },
  },
  server: {
    port: 5180,
  },
  optimizeDeps: {
    include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
  worker: {
    rollupOptions: {
      // @pierre/diffs 的 worker 入口依赖 import 后注册 message 监听（同 packages/web）。
      treeshake: false,
    },
  },
});
