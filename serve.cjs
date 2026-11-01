const http = require('node:http'),
  fs = require('node:fs'),
  path = require('node:path');

const root = path.resolve(__dirname, 'dist');
const port = Number(process.env.PORT || 4188);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer between 1 and 65535.');

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let filename;
  try {
    filename = path.resolve(
      root,
      '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname),
    );
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (filename !== root && !filename.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  if (fs.existsSync(filename) && fs.statSync(filename).isDirectory()) {
    filename = path.join(filename, 'index.html');
  }
  fs.readFile(filename, (e, b) => {
    if (e) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type':
        types[path.extname(filename)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(b);
  });
});

server.listen(port, '127.0.0.1', () =>
  console.log(`ROM Studio: http://localhost:${port}`),
);
