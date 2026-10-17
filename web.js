const express = require('express');
const path = require('path');
const fs = require('fs');

/**
 * Site + API + downloads, rodando no mesmo processo do bot.
 * Compartilha o mesmo "db" do bot, então tudo que é lançado no Discord aparece aqui na hora.
 */
function startWeb({ getDb, save, client, storageDir, brand, port }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    next();
  });

  /* ---------- tempo real (Server-Sent Events) ---------- */
  const clients = new Set();
  const broadcast = (type, id) => {
    const payload = `event: ${type}\ndata: ${JSON.stringify({ id })}\n\n`;
    for (const res of clients) res.write(payload);
  };

  let saveTimer;
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 2000); };

  /* ---------- limitador simples de downloads por IP ---------- */
  const hits = new Map();
  const limited = (ip) => {
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < 10 * 60e3);
    arr.push(now);
    hits.set(ip, arr);
    return arr.length > 60;
  };
  setInterval(() => hits.clear(), 30 * 60e3).unref();

  /* ---------- API ---------- */
  const toPublic = (s) => ({
    id: s.id,
    nome: s.nome,
    desc: s.desc,
    cat: s.cat || 'Outros',
    link: s.link || null,
    file: s.file ? { name: s.file.name, size: s.file.size } : null,
    by: s.by?.tag || '—',
    at: s.at,
    downloads: s.downloads || 0,
  });

  app.get('/api/config', (req, res) => {
    res.json({
      brand,
      invite: process.env.DISCORD_INVITE || null,
      contact: process.env.CONTACT || null,
    });
  });

  app.get('/api/status', (req, res) => {
    const guild = client.guilds.cache.first();
    res.json({
      online: client.isReady(),
      ping: client.isReady() ? Math.round(client.ws.ping) : -1,
      members: guild ? guild.memberCount : null,
      uptime: Math.floor(process.uptime()),
    });
  });

  app.get('/api/sources', (req, res) => {
    const list = Object.values(getDb().sources || {})
      .filter((s) => s.file || s.link)
      .sort((a, b) => b.at - a.at)
      .map(toPublic);
    res.set('Cache-Control', 'no-store').json(list);
  });

  app.get('/api/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    clients.add(res);
    const hb = setInterval(() => res.write(': hb\n\n'), 25000);
    req.on('close', () => { clearInterval(hb); clients.delete(res); });
  });

  /* ---------- download ---------- */
  app.get('/download/:id', (req, res) => {
    if (limited(req.ip)) return res.status(429).type('text').send('Muitos downloads em pouco tempo. Tente novamente em alguns minutos.');
    const id = String(req.params.id);
    if (!/^[a-f0-9]{10}$/.test(id)) return res.status(404).type('text').send('Não encontrado.');
    const s = getDb().sources?.[id];
    if (!s || !s.file) return res.status(404).type('text').send('Arquivo não encontrado.');

    const filePath = path.resolve(storageDir, s.file.stored);
    if (!filePath.startsWith(path.resolve(storageDir) + path.sep) || !fs.existsSync(filePath)) {
      return res.status(410).type('text').send('Esse arquivo não está mais disponível.');
    }
    s.downloads = (s.downloads || 0) + 1;
    saveSoon();
    broadcast('dl', id);
    res.download(filePath, s.file.name);
  });

  /* ---------- site estático ---------- */
  app.use(express.static(path.join(__dirname, 'site'), { etag: true, maxAge: 0 }));
  app.use((req, res) => res.status(404).type('text').send('Página não encontrada.'));

  app.listen(port, '0.0.0.0', () => console.log(`🌐 Site no ar na porta ${port} (${process.env.PUBLIC_URL || `http://localhost:${port}`})`));

  return { broadcast };
}

module.exports = { startWeb };