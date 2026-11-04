import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// dsh web origin (default: `pnpm exec dsh --profile hibuddy` listens on 3080).
// The proxy target and the injected Origin header must share one authority:
// dsh's trust fence rejects requests whose Origin differs from the Host, so
// the dev-server origin (localhost:5173) is rewritten to the dsh origin.
const dshUrl = process.env.DSH_URL ?? 'http://127.0.0.1:3080'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Login-token exchange: GET /connect?token=… answers 302 + Set-Cookie.
      // The page uses redirect:'manual', so the cookie still lands on the
      // opaqueredirect response in the browser.
      '/connect': { target: dshUrl, changeOrigin: true, headers: { origin: dshUrl } },
      // AG-UI HTTP+SSE endpoint: POST /agui (streamed uncompressed, so the
      // http-proxy passthrough keeps token-level streaming intact).
      '/agui': { target: dshUrl, changeOrigin: true, headers: { origin: dshUrl } },
    },
  },
})
