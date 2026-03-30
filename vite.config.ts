import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

type RelayPayload = {
  image: string;
  createdAt: number;
};

const relayStore = new Map<string, RelayPayload>();
const RELAY_TTL_MS = 10 * 60 * 1000;

const cleanupRelayStore = () => {
  const now = Date.now();
  for (const [sessionId, payload] of relayStore.entries()) {
    if (now - payload.createdAt > RELAY_TTL_MS) {
      relayStore.delete(sessionId);
    }
  }
};

const readJsonBody = async (req: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
};

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const useHttps = mode === 'https' || (env.VITE_DEV_HTTPS || '').toLowerCase() === 'true';
  return {
    plugins: [
      react(),
      tailwindcss(),
      useHttps && basicSsl(),
      {
        name: 'solarguard-relay-api',
        configureServer(server) {
          server.middlewares.use('/api/relay', async (req, res, next) => {
            cleanupRelayStore();

            const [sessionPath = '', query = ''] = (req.url || '/').split('?');
            const sessionId = sessionPath.replace(/^\/+/, '').trim();

            if (!sessionId) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({error: 'Missing relay session ID.'}));
              return;
            }

            if (req.method === 'POST') {
              try {
                const body = await readJsonBody(req);
                const image = typeof body.image === 'string' ? body.image : '';

                if (!image.startsWith('data:image/')) {
                  res.statusCode = 400;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({error: 'Invalid image payload.'}));
                  return;
                }

                relayStore.set(sessionId, {image, createdAt: Date.now()});
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ok: true}));
                return;
              } catch {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({error: 'Invalid JSON payload.'}));
                return;
              }
            }

            if (req.method === 'GET') {
              const payload = relayStore.get(sessionId);
              const take = new URLSearchParams(query).get('take') === '1';

              if (!payload) {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({image: null}));
                return;
              }

              if (take) {
                relayStore.delete(sessionId);
              }

              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({image: payload.image, createdAt: payload.createdAt}));
              return;
            }

            next();
          });
        },
      },
    ],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'import.meta.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'import.meta.env.VITE_GEMINI_API_KEY': JSON.stringify(
        env.VITE_GEMINI_API_KEY || env.GEMINI_API_KEY,
      ),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      https: useHttps,
    },
  };
});
