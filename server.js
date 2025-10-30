import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

const PROXY_ALLOWLIST = new Set([
  'https://api.openai.com',
  'https://api.anthropic.com',
  'https://generativelanguage.googleapis.com',
  'https://api.x.ai'
]);

async function resolveFilePath(url) {
  const cleanUrl = url.split('?')[0].split('#')[0];
  const targetPath = cleanUrl === '/' ? 'index.html' : cleanUrl.replace(/^\/+/, '');
  const absolutePath = join(__dirname, targetPath);
  try {
    const fileStats = await stat(absolutePath);
    if (fileStats.isDirectory()) {
      return join(absolutePath, 'index.html');
    }
    return absolutePath;
  } catch (_error) {
    return null;
  }
}

function isProxyAllowed(endpoint) {
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:') {
      return false;
    }
    const origin = `${parsed.protocol}//${parsed.host}`;
    return PROXY_ALLOWLIST.has(origin);
  } catch (_error) {
    return false;
  }
}

async function handleProxyRequest(request, response) {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    response.end();
    return;
  }

  if (request.method !== 'POST') {
    response.writeHead(405, {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json; charset=utf-8'
    });
    response.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const chunks = [];
  request.on('data', (chunk) => {
    chunks.push(chunk);
  });

  request.on('end', async () => {
    let payload = {};
    try {
      const rawBody = Buffer.concat(chunks).toString('utf-8') || '{}';
      payload = JSON.parse(rawBody);
    } catch (_error) {
      response.writeHead(400, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json; charset=utf-8'
      });
      response.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      return;
    }

    const { endpoint, method = 'POST', headers = {}, body = null } = payload;
    if (typeof endpoint !== 'string' || !isProxyAllowed(endpoint)) {
      response.writeHead(403, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json; charset=utf-8'
      });
      response.end(JSON.stringify({ error: 'Endpoint not allowed for proxy', endpoint }));
      return;
    }

    try {
      console.log(`[proxy] ${method} ${endpoint}`);
      const upstreamResponse = await fetch(endpoint, {
        method,
        headers,
        body: body === null || body === undefined ? undefined : body
      });

      const contentType = upstreamResponse.headers.get('content-type') || 'application/octet-stream';
      const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
      console.log(`[proxy] ${endpoint} -> ${upstreamResponse.status}`);
      response.writeHead(upstreamResponse.status, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      response.end(buffer);
    } catch (_error) {
      console.error('[proxy] request failed', _error);
      response.writeHead(502, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json; charset=utf-8'
      });
      response.end(JSON.stringify({ error: 'Proxy request failed' }));
    }
  });
}

const server = createServer(async (request, response) => {
  if (!request.url) {
    response.writeHead(400).end('Bad Request');
    return;
  }

  const cleanUrl = request.url.split('?')[0];
  if (cleanUrl === '/api/proxy') {
    await handleProxyRequest(request, response);
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end('Method Not Allowed');
    return;
  }

  const filePath = await resolveFilePath(request.url);
  if (!filePath) {
    response.writeHead(404).end('Not Found');
    return;
  }

  const extension = extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[extension] || 'application/octet-stream';

  try {
    const body = request.method === 'HEAD' ? null : await readFile(filePath);
    response.writeHead(200, { 'Content-Type': mimeType });
    if (body) {
      response.end(body);
    } else {
      response.end();
    }
  } catch (_error) {
    console.error('Error serving', filePath, _error);
    response.writeHead(500).end('Internal Server Error');
  }
});

server.listen(PORT, HOST, () => {
  const hostname = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`SimpleWriter server running at http://${hostname}:${PORT}`);
});
