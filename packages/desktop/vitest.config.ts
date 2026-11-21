import { defineConfig } from "vitest/config";

// Renderer production builds use the automatic React JSX runtime.
export default defineConfig({ esbuild: { jsx: "automatic" } });
