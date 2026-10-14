/* ============================================================================
   本机静态服务器
   ----------------------------------------------------------------------------
   运行：node tools/serve.mjs      （Windows 上也可以直接双击 tools/serve.cmd）

   为什么需要它：Web MIDI 只在一个「安全上下文」里可用。https 和 http://localhost
   都算，但 file:// 算不算，各家浏览器、各个版本并不一致 —— 一旦浏览器拒绝，
   表现就是连接时报 SecurityError。这时候唯一的出路就是换成真正的本机地址，
   也就是这个脚本提供的东西。

   只为这一件事存在，所以故意写得没有依赖、没有构建、也不监听外网
   （绑定 127.0.0.1，不是 0.0.0.0）。
   ========================================================================= */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.syx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
};

const norm = (p) => p.replace(/\\/g, '/').toLowerCase();

const server = createServer(async (req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400).end('400');
    return;
  }
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);

  /* 只服务这个仓库目录里的东西，别把整个硬盘端出去 */
  if (!norm(file).startsWith(norm(ROOT) + '/')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('403');
    return;
  }

  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 ' + rel);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已经被占用了。换一个：PORT=8081 node tools/serve.mjs`);
  } else {
    console.error('起不来：', e.message);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  FM-1 音色台已经在本机跑起来了。用 Chrome 或 Edge 打开：');
  console.log('');
  console.log(`      http://localhost:${PORT}/`);
  console.log('');
  console.log('  在这个地址下，写入设备那一区的 MIDI 权限就不会被浏览器拦。');
  console.log('  用完按 Ctrl+C 停掉。');
  console.log('');
});
