import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The OAuth provider imports the Workers runtime at module scope; stub it for Node.
    alias: { "cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Inline the provider so the alias above applies to its imports too.
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
