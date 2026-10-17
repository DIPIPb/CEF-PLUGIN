// Иконки предметов Rust: сайт сам скачивает их с rustlabs (и запасных сайтов) и отдаёт со своего домена.
// Адрес для страницы: /icons/<shortname>.png  (см. rewrites в vercel.json) -> /api/icon?id=<shortname>
// Vercel CDN кэширует ответ на год, так что каждая иконка скачивается один раз.
const HOSTS = [
  n => `https://rustlabs.com/img/items180/${encodeURIComponent(n)}.png`,
  n => `https://www.rustedit.io/images/imagelibrary/${encodeURIComponent(n)}.png`,
  n => `https://wiki.rustclash.com/img/items180/${encodeURIComponent(n)}.png`
];

async function load(id) {
  const names = [id];
  if (id.includes(' ')) names.push(id.replace(/ +/g, '.'));      // 'military flamethrower' -> 'military.flamethrower'
  for (const n of names) {
    for (const h of HOSTS) {
      try {
        const r = await fetch(h(n), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
        if (!r.ok) continue;
        const type = r.headers.get('content-type') || '';
        if (!type.startsWith('image/')) continue;
        const b = Buffer.from(await r.arrayBuffer());
        if (b.length < 500) continue;
        return b;
      } catch (e) { /* пробуем следующий источник */ }
    }
  }
  return null;
}

module.exports = async (req, res) => {
  let id = String((req.query && req.query.id) || '');
  try { id = decodeURIComponent(id); } catch (e) { /* оставляем как есть */ }
  id = id.trim().toLowerCase();
  if (!/^[a-z0-9._ -]{1,48}$/.test(id) || id.includes('..')) {
    res.statusCode = 400;
    return res.end('bad id');
  }
  const img = await load(id);
  if (!img) {
    res.statusCode = 404;
    res.setHeader('Cache-Control', 'public, s-maxage=3600');
    return res.end('not found');
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
  res.end(img);
};
