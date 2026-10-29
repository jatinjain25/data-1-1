import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/* `npm run dev` runs the API (server.js) on 8787 and this on 5180, proxying
   /api and the tracker to it. */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: { "/api": "http://localhost:8787", "/t.js": "http://localhost:8787" },
  },
  build: { outDir: "dist", sourcemap: false },
});
