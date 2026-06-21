import { createServerFn } from "@tanstack/react-start";

// Estado compartilhado entre operador (index.tsx) e bot (/meet) pelo servidor Nitro.
// Persiste durante a vida da instância Lambda (warm path). Cold start = false = padrão seguro.
let meetListenPaused = false;

export const setMeetListenPaused = createServerFn({ method: "POST" })
  .inputValidator((data: { paused: boolean }) => data)
  .handler(async ({ data }) => {
    meetListenPaused = data.paused;
    return { ok: true, paused: meetListenPaused };
  });

export const getMeetListenPaused = createServerFn({ method: "GET" })
  .handler(async () => ({ paused: meetListenPaused }));
