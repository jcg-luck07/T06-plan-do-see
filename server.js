// 내 컴퓨터에서 시험할 때 쓰는 서버. (배포 때는 Vercel이 같은 일을 해 줍니다)
const http = require('http');
const fs = require('fs');
const path = require('path');
const handler = require('./lib/handler');

const PUBLIC = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) return handler(req, res);
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.statusCode = 403; return res.end('금지'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('없는 페이지'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache'); // 고친 화면이 바로 보이도록
    res.end(data);
  });
});

const port = Number(process.env.PORT) || 3000;
if (require.main === module) {
  server.listen(port, () => console.log(`http://localhost:${port} 에서 열려 있습니다`));
}
module.exports = server;
