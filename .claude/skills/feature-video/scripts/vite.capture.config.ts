import { mergeConfig, defineConfig } from 'vite';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import base from './vite.config';

const fixtures = process.env.NOD_CAPTURE_FIXTURES!;
const log = process.env.NOD_CAPTURE_LOG!;

export default mergeConfig(
  base,
  defineConfig({
    server: {
      port: Number(process.env.NOD_CAPTURE_PORT ?? 4395),
      strictPort: true,
      host: '127.0.0.1',
    },
    plugins: [
      {
        name: 'nod-capture-fixtures',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/api/')) return next();
            const data = JSON.parse(readFileSync(fixtures, 'utf8'));
            const path = req.url;
            const bare = path.split('?')[0];
            const key = `${req.method} ${path}`;
            const hit = [key, `${req.method} ${bare}`, path, bare].find((k) => k in data);
            appendFileSync(log, `${hit ? 'HIT ' : 'MISS'} ${key}\n`);
            if (req.headers.accept?.includes('text/event-stream')) {
              res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
              });
              res.write(': capture\n\n');
              return;
            }
            if (!hit) {
              res.writeHead(404, { 'content-type': 'application/json' });
              return res.end(JSON.stringify({ error: `No fixture for ${key}` }));
            }
            const value = data[hit];
            const scripted = value && typeof value === 'object' && '$respond' in value;
            if (scripted && value.$then)
              writeFileSync(fixtures, JSON.stringify({ ...data, ...value.$then }));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(scripted ? value.$respond : value));
          });
        },
      },
    ],
  }),
);
