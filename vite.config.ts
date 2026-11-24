import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// MapLibre lädt seinen Worker über eine URL relativ zur eigenen Datei: das geht nur, wenn es nicht vorgebündelt wird.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ['maplibre-gl', '@maplibre/maplibre-gl-leaflet'] },
  test: { setupFiles: ['./src/testSetup.ts'] },
})
