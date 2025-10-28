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
  } catch (error) {
    return null;
  }
}

const server = createServer(async (request, response) => {
  if (!request.url) {
    response.writeHead(400).end('Bad Request');
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
  } catch (error) {
    console.error('Error serving', filePath, error);
    response.writeHead(500).end('Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log(`SimpleWriter server running at http://localhost:${PORT}`);
});
