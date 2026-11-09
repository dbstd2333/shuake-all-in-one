// 本机状态接口：给未来的 GUI / 监控 / 探活脚本用
import http from 'node:http';

export function startStatusServer(supervisor, { host = '127.0.0.1', port = 8790, logger } = {}) {
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => {
      const data = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
      res.end(data);
    };

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/status') return send(200, supervisor.status());
      if (req.method === 'POST' && url.pathname === '/pause') { supervisor.pause(); return send(200, supervisor.status()); }
      if (req.method === 'POST' && url.pathname === '/resume') { supervisor.resume(); return send(200, supervisor.status()); }
      if (req.method === 'POST' && url.pathname === '/stop') { supervisor.stop(); return send(200, { stopping: true }); }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(500, { error: e.message });
    }
  });

  server.listen(port, host, () => logger?.info(`状态接口：http://${host}:${port}/status`));
  server.on('error', (e) => logger?.warn(`状态接口启动失败：${e.message}`));
  return server;
}
