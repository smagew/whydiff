import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// main and preload keep their deps external (better-sqlite3 is a native module that
// must load from node_modules at runtime, not be bundled); the renderer is a normal
// Vite + React build.
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] },
})
