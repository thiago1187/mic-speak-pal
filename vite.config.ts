// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  // Desliga o overlay vermelho de erro do Vite no dev — quando um erro (ex.: token
  // recusado) acontecia, ele cobria a tela toda e travava o site. Os erros continuam
  // no console e no LOG do app, tratados de forma amigável; só não cobrem mais a UI.
  vite: {
    server: { hmr: { overlay: false } },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  // Só ativa o plugin de deploy do nitro quando NITRO_PRESET está setado (ex.: Vercel).
  // Sem o env, `nitro` fica undefined = comportamento ORIGINAL: o Lovable (sandbox)
  // segue buildando para Cloudflare; o build local fora do sandbox pula o nitro.
  // Para Vercel: NITRO_PRESET=vercel → escreve o Build Output API em .vercel/output
  // (o config do Lovable força output.dir=dist; aqui sobrescrevemos de volta).
  nitro: process.env.NITRO_PRESET
    ? {
        preset: process.env.NITRO_PRESET,
        ...(process.env.NITRO_PRESET === "vercel"
          ? {
              // Caminhos EXATOS do preset vercel do nitro (o config do Lovable
              // os força pra dist/*, então sobrescrevemos de volta). O servidor
              // vai direto pra __server.func, que é o destino /__server do config.json.
              output: {
                dir: ".vercel/output",
                serverDir: ".vercel/output/functions/__server.func",
                publicDir: ".vercel/output/static",
              },
            }
          : {}),
      }
    : undefined,
});
