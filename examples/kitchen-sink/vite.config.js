import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * @storybook/react-vite does not bring a React plugin of its own, so without
 * this the .jsx files compile with the classic JSX runtime and every story
 * fails at runtime with "React is not defined". Storybook's Vite builder picks
 * this config up on its own.
 */
export default defineConfig({
  plugins: [react()],
})
