import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 4310, strictPort: true },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'markdown',
              test: /node_modules[\\/](react-markdown|remark-gfm|rehype-raw|rehype-sanitize)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
