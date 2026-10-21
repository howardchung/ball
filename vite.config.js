import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The browser can't call the Power BI endpoint directly (CORS + Origin header),
// so dev/preview servers proxy /pbi/* to it and add the headers it expects.
const proxy = {
  '/pbi': {
    target: 'https://wabi-us-gov-iowa-api.analysis.usgovcloudapi.net',
    changeOrigin: true,
    secure: true,
    rewrite: (p) => p.replace(/^\/pbi/, ''),
    headers: { Origin: 'https://app.powerbigov.us', Referer: 'https://app.powerbigov.us/' },
  },
}
export default defineConfig({ plugins: [react()], server: { proxy }, preview: { proxy } })
