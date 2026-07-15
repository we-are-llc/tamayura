import { defineConfig } from "vite";

export default defineConfig({
  // 相対パスにしておくと GitHub Pages のサブパス配信でも動く
  base: "./",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 6000
  }
});
