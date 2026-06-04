// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  // Habilita o plugin de deploy do nitro também fora do sandbox do Lovable (ex.: Vercel).
  // O preset vem de NITRO_PRESET; default cloudflare-module mantém o Lovable intacto.
  // Para Vercel, rode o build com NITRO_PRESET=vercel (gera .vercel/output).
  // O config do Lovable força output.dir=dist; no preset vercel sobrescrevemos
  // de volta pro layout do Build Output API que o Vercel espera.
  nitro:
    process.env.NITRO_PRESET === "vercel"
      ? {
          preset: "vercel",
          output: {
            dir: ".vercel/output",
            serverDir: ".vercel/output/functions/__nitro.func",
            publicDir: ".vercel/output/static",
          },
        }
      : { preset: process.env.NITRO_PRESET ?? "cloudflare-module" },
});
