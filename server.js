const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');
const https   = require('https');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 10000;
const DATA_FILE = path.join(__dirname, 'bans.json');

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || 'YOUR_WEBHOOK_HERE';
const HMAC_SECRET     = process.env.DIPRUST_SECRET  || 'xK9#mP2$nQ7!wL4@vR8&';

const RCON_HOST     = process.env.RCON_HOST     || '127.0.0.1';
const RCON_PORT     = parseInt(process.env.RCON_PORT || '28016');
const RCON_PASSWORD = process.env.RCON_PASSWORD || '';

const activeHeartbeats = new Map();

// ── ТОКЕН: вычисление ─────────────────────────────────────────────────────────
function computeToken(steamId, data) {
  try {
    const hour = new Date().toISOString().slice(0, 13).replace(/[-T:]/g, '');
    const raw  = steamId + data + hour;
    return crypto.createHmac('sha256', HMAC_SECRET).update(raw).digest('hex');
  } catch (e) { return ''; }
}

// ── ТОКЕН: проверка с окном ±3 часа ──────────────────────────────────────────
function verifyToken(steamId, data, token) {
  if (!token || token.length !== 64) return false;
  const now = new Date();
  const makeHour = (d) => d.toISOString().slice(0, 13).replace(/[-T:]/g, '');
  for (let offset = -3; offset <= 3; offset++) {
    const shifted  = new Date(now.getTime() + offset * 3_600_000);
    const raw      = steamId + data + makeHour(shifted);
    const expected = crypto.createHmac('sha256', HMAC_SECRET).update(raw).digest('hex');
    try {
      if (crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'))) return true;
    } catch {}
  }
  return false;
}

async function rconKick(steamId, reason) {
  if (!RCON_PASSWORD) return;
  try {
    const { Rcon } = require('rcon-client');
    const rcon = new Rcon({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD });
    await rcon.connect();
    await rcon.send(`kick ${steamId} "${reason}"`);
    await rcon.end();
    console.log(`[DIPRUST] RCON кик: ${steamId} — ${reason}`);
  } catch (e) { console.warn('[DIPRUST] RCON ошибка:', e.message); }
}

function sendDiscordWebhook(title, description, fields, color) {
  if (!DISCORD_WEBHOOK || DISCORD_WEBHOOK === 'YOUR_WEBHOOK_HERE') return;
  try {
    const body = JSON.stringify({
      embeds: [{
        title, description, color,
        timestamp: new Date().toISOString(),
        fields: fields.map(f => ({ name: f.name, value: String(f.value || '-'), inline: true }))
      }]
    });
    const url = new URL(DISCORD_WEBHOOK);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    });
    req.on('error', () => {});
    req.write(body); req.end();
  } catch (e) {}
}

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const sessions      = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return { hash, salt };
}
function verifyPassword(password, hash, salt) {
  return crypto.createHmac('sha256', salt).update(password).digest('hex') === hash;
}
function loadAccounts() {
  try { if (fs.existsSync(ACCOUNTS_FILE)) return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch (e) {}
  return { accounts: [] };
}
function saveAccounts(data) { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2)); }
function ensureDefaultAdmin() {
  const data = loadAccounts();
  if (!data.accounts || data.accounts.length === 0) {
    const { hash, salt } = hashPassword('admin123');
    data.accounts = [{ id: crypto.randomBytes(16).toString('hex'), username: 'admin', hash, salt, role: 'superadmin', createdAt: new Date().toISOString(), createdBy: 'system', lastLogin: null, active: true }];
    saveAccounts(data);
    console.log('[DIPRUST] Создан аккаунт по умолчанию: admin / admin123  ← СМЕНИТЕ ПАРОЛЬ!');
  }
}
ensureDefaultAdmin();

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || (req.headers['authorization']||'').replace('Bearer ','');
  if (!token) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const session = sessions.get(token);
  if (!session) return res.status(401).json({ ok: false, error: 'invalid_token' });
  if (Date.now() - session.createdAt > SESSION_TTL_MS) { sessions.delete(token); return res.status(401).json({ ok: false, error: 'token_expired' }); }
  req.session = session; next();
}
function requireSuperAdmin(req, res, next) {
  if (req.session.role !== 'superadmin') return res.status(403).json({ ok: false, error: 'forbidden' });
  next();
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE))
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {}
  return { bans: [], players: [], screenshotRequests: {}, checkRequests: {}, checkDoneRequests: {}, activeChecks: {} };
}
function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

// ── AUTH ───────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });
  const data    = loadAccounts();
  const account = (data.accounts || []).find(a => a.username === username && a.active !== false);
  if (!account || !verifyPassword(password, account.hash, account.salt))
    return res.status(401).json({ ok: false, error: 'invalid_credentials' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { id: account.id, username: account.username, role: account.role, createdAt: Date.now() });
  account.lastLogin = new Date().toISOString();
  saveAccounts(data);
  res.json({ ok: true, token, username: account.username, role: account.role });
});
app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = req.headers['x-auth-token'] || (req.headers['authorization']||'').replace('Bearer ','');
  sessions.delete(token); res.json({ ok: true });
});
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, username: req.session.username, role: req.session.role });
});

// ── ACCOUNTS ──────────────────────────────────────────────────────────────────
app.get('/api/accounts', requireAuth, requireSuperAdmin, (req, res) => {
  const data = loadAccounts();
  res.json((data.accounts || []).map(a => ({ id:a.id, username:a.username, role:a.role, createdAt:a.createdAt, createdBy:a.createdBy, lastLogin:a.lastLogin, active:a.active!==false })));
});
app.post('/api/accounts', requireAuth, requireSuperAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });
  if (!['superadmin','admin','moderator'].includes(role)) return res.status(400).json({ ok: false, error: 'invalid_role' });
  const data = loadAccounts();
  if ((data.accounts||[]).find(a => a.username === username)) return res.status(409).json({ ok: false, error: 'username_taken' });
  const { hash, salt } = hashPassword(password);
  const acc = { id: crypto.randomBytes(16).toString('hex'), username, hash, salt, role, createdAt: new Date().toISOString(), createdBy: req.session.username, lastLogin: null, active: true };
  data.accounts.push(acc); saveAccounts(data);
  res.json({ ok: true, id: acc.id });
});
app.put('/api/accounts/me/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ ok: false, error: 'missing_fields' });
  if (newPassword.length < 6) return res.status(400).json({ ok: false, error: 'password_too_short' });
  const data    = loadAccounts();
  const account = (data.accounts||[]).find(a => a.id === req.session.id);
  if (!account) return res.status(404).json({ ok: false, error: 'not_found' });
  if (!verifyPassword(currentPassword, account.hash, account.salt)) return res.status(401).json({ ok: false, error: 'wrong_current_password' });
  const { hash, salt } = hashPassword(newPassword);
  account.hash = hash; account.salt = salt; saveAccounts(data);
  res.json({ ok: true });
});
app.put('/api/accounts/:id', requireAuth, requireSuperAdmin, (req, res) => {
  const { password, role, active } = req.body || {};
  const data    = loadAccounts();
  const account = (data.accounts||[]).find(a => a.id === req.params.id);
  if (!account) return res.status(404).json({ ok: false, error: 'not_found' });
  if (account.username === req.session.username && active === false) return res.status(400).json({ ok: false, error: 'cannot_deactivate_self' });
  if (password) { const { hash, salt } = hashPassword(password); account.hash = hash; account.salt = salt; }
  if (role && ['superadmin','admin','moderator'].includes(role)) account.role = role;
  if (typeof active === 'boolean') { account.active = active; if (!active) for (const [t,s] of sessions.entries()) if (s.id===account.id) sessions.delete(t); }
  saveAccounts(data); res.json({ ok: true });
});
app.delete('/api/accounts/:id', requireAuth, requireSuperAdmin, (req, res) => {
  const data    = loadAccounts();
  const account = (data.accounts||[]).find(a => a.id === req.params.id);
  if (!account) return res.status(404).json({ ok: false, error: 'not_found' });
  if (account.username === req.session.username) return res.status(400).json({ ok: false, error: 'cannot_delete_self' });
  data.accounts = data.accounts.filter(a => a.id !== req.params.id);
  for (const [t,s] of sessions.entries()) if (s.id===account.id) sessions.delete(t);
  saveAccounts(data); res.json({ ok: true });
});

// ── HEARTBEAT ─────────────────────────────────────────────────────────────────
app.post('/api/heartbeat', (req, res) => {
  const { steamid, hwid, token } = req.body || {};
  if (!steamid || !hwid) return res.status(400).json({ ok: false, error: 'missing fields' });
  if (token && !verifyToken(steamid, hwid, token)) {
    console.warn(`[DIPRUST] Heartbeat: токен не совпал для ${steamid}`);
    if (token.length !== 64) {
      sendDiscordWebhook('⚠️ Heartbeat Spoofed', 'Токен неверной длины', [
        { name: 'Steam ID', value: steamid },
        { name: 'HWID',     value: hwid ? hwid.substring(0, 20) + '…' : '—' },
        { name: 'Длина токена', value: token.length }
      ], 0xe74c3c);
      return res.status(403).json({ ok: false, error: 'invalid token' });
    }
  }
  const data   = loadData();
  const player = (data.players || []).find(p => p.steamId === steamid);
  activeHeartbeats.set(steamid, { hwid, lastSeen: Date.now(), name: player ? player.name : '' });
  res.json({ ok: true });
});

app.get('/api/heartbeat_status', (req, res) => {
  const result = {};
  const now    = Date.now();
  for (const [steamId, info] of activeHeartbeats.entries()) {
    result[steamId] = {
      hwid: info.hwid, name: info.name,
      lastSeen: new Date(info.lastSeen).toISOString(),
      alive: (now - info.lastSeen) < 60_000,
      age: Math.floor((now - info.lastSeen) / 1000) + 's'
    };
  }
  res.json(result);
});

// Очистка по таймауту heartbeat
setInterval(async () => {
  const now = Date.now();
  for (const [steamId, info] of activeHeartbeats.entries()) {
    const elapsed = now - info.lastSeen;
    if (elapsed > 60_000) {
      console.warn(`[DIPRUST] Heartbeat timeout: ${info.name || steamId} (${Math.floor(elapsed/1000)}s)`);
      activeHeartbeats.delete(steamId);
      try {
        const d = loadData();
        const p = d.players.find(pl => pl.steamId === steamId);
        if (p) { p.hwid = ''; saveData(d); }
      } catch(e) { console.log(`[DIPRUST] Ошибка очистки HWID: ${e.message}`); }
      sendDiscordWebhook('🚨 AntiCheat Offline', 'Клиент не прислал heartbeat — античит убит или заморожен', [
        { name: 'Steam ID', value: steamId },
        { name: 'Игрок',   value: info.name || '—' },
        { name: 'Молчит',  value: Math.floor(elapsed / 1000) + ' сек' }
      ], 0xe74c3c);
      await rconKick(steamId, 'AntiCheat не отвечает');
    }
  }
}, 30_000);

// ── /api/check ────────────────────────────────────────────────────────────────
app.post('/api/check', (req, res) => {
  const { hwid, steamid, name, token } = req.body;
  if (!hwid && !steamid) return res.json({ banned: false });
  if (token) {
    if (!verifyToken(steamid || '', hwid || '', token)) {
      console.warn(`[DIPRUST] /api/check: токен не совпал для ${steamid}`);
      if (token.length !== 64) {
        sendDiscordWebhook('⚠️ Check Request Spoofed', 'Токен неверной длины в /api/check', [
          { name: 'Steam ID', value: steamid || '—' },
          { name: 'HWID',     value: hwid ? hwid.substring(0, 20) + '…' : '—' },
          { name: 'Длина токена', value: token.length }
        ], 0xe74c3c);
        return res.status(403).json({ ok: false, error: 'invalid token' });
      }
    }
  }
  const data    = loadData();
  const hwidLow = (hwid || '').toLowerCase();
  const ban     = data.bans.find(b => {
    if (b.hwid && hwidLow && b.hwid === hwidLow) return true;
    if (b.steamId && !b.hwid && steamid && b.steamId === steamid) return true;
    return false;
  });
  const now      = new Date().toISOString();
  const existing = data.players.find(p => p.steamId === steamid);
  if (existing) { existing.name = name || existing.name; existing.hwid = hwidLow || existing.hwid; existing.lastSeen = now; }
  else if (steamid) data.players.push({ steamId: steamid, name: name || 'Unknown', hwid: hwidLow, lastSeen: now, discordTag: '' });
  saveData(data);

  const responseBody = ban
    ? '{"banned":true,"reason":' + JSON.stringify(ban.reason || '') + '}'
    : '{"banned":false}';

  const makeHourStr = (offsetH) => {
    const d = new Date(Date.now() + offsetH * 3_600_000);
    return d.toISOString().slice(0, 13).replace(/[-T:]/g, '');
  };
  const allSigs = [];
  for (let h = -3; h <= 1; h++) {
    const raw = (steamid || '') + responseBody + makeHourStr(h);
    allSigs.push(crypto.createHmac('sha256', HMAC_SECRET).update(raw).digest('hex'));
  }
  const bodyBuffer = Buffer.from(responseBody, 'utf8');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', bodyBuffer.length);
  res.setHeader('X-Sig',     allSigs[3]);
  res.setHeader('X-Sig-All', allSigs.join('|'));
  res.end(bodyBuffer);
});

// ── DISCORD TAG ───────────────────────────────────────────────────────────────
app.post('/api/player_discord', (req, res) => {
  const { steamId, discordTag, name } = req.body || {};
  if (!steamId || !discordTag) return res.status(400).json({ error: 'steamId and discordTag required' });
  const data   = loadData();
  const player = data.players.find(p => p.steamId === steamId);
  if (player) { player.discordTag = discordTag; player.name = name || player.name; }
  else data.players.push({ steamId, name: name || 'Unknown', hwid: '', lastSeen: new Date().toISOString(), discordTag });
  saveData(data);
  res.json({ ok: true });
});
app.get('/api/player_discord/:steamId', (req, res) => {
  const data   = loadData();
  const player = data.players.find(p => p.steamId === req.params.steamId);
  res.json({ discordTag: player ? (player.discordTag || '') : '' });
});

// ── CHECK REQUESTS ────────────────────────────────────────────────────────────
app.get('/api/check_pending/:steamId', (req, res) => {
  const data  = loadData();
  if (!data.checkRequests) data.checkRequests = {};
  const entry = data.checkRequests[req.params.steamId];
  if (entry) res.json({ pending: true, requestedBy: entry.requestedBy || 'Admin', requestedAt: entry.requestedAt });
  else res.json({ pending: false });
});
app.delete('/api/check_pending/:steamId', (req, res) => {
  const data = loadData();
  if (!data.checkRequests) data.checkRequests = {};
  delete data.checkRequests[req.params.steamId];
  saveData(data); res.json({ ok: true });
});
app.post('/api/check_request/:steamId', requireAuth, (req, res) => {
  const data        = loadData();
  if (!data.checkRequests) data.checkRequests = {};
  const requestedBy = (req.body && req.body.requestedBy) ? req.body.requestedBy : 'Admin';
  if (!data.activeChecks) data.activeChecks = {};
  const player = (data.players || []).find(p => p.steamId === req.params.steamId);
  const entry = {
    requestedBy, requestedAt: new Date().toISOString(), status: 'active',
    playerName: player ? (player.name || '') : '',
    discordTag: player ? (player.discordTag || '') : '',
    hwid:       player ? (player.hwid || '') : ''
  };
  data.checkRequests[req.params.steamId] = entry;
  data.activeChecks[req.params.steamId]  = entry;
  saveData(data);
  sendDiscordWebhook('🔍 Вызов на проверку', 'Игрок вызван через панель', [
    { name: 'Steam ID', value: req.params.steamId },
    { name: 'Игрок',   value: player ? player.name : '—' },
    { name: 'Discord', value: player && player.discordTag ? player.discordTag : '—' },
    { name: 'Вызвал',  value: requestedBy }
  ], 0x3498db);
  res.json({ ok: true });
});
app.post('/api/check_done/:steamId', requireAuth, (req, res) => {
  const data    = loadData();
  if (!data.checkRequests)     data.checkRequests     = {};
  if (!data.checkDoneRequests) data.checkDoneRequests = {};
  const steamId = req.params.steamId;
  const result  = (req.body && req.body.result)  || 'pass';
  const by      = (req.body && req.body.by)      || 'Admin';
  const banType = (req.body && req.body.banType) || 'both';
  delete data.checkRequests[steamId];
  if (!data.activeChecks) data.activeChecks = {};
  if (data.activeChecks[steamId]) {
    data.activeChecks[steamId].status     = result === 'fail' ? 'fail' : 'pass';
    data.activeChecks[steamId].finishedBy = by;
    data.activeChecks[steamId].finishedAt = new Date().toISOString();
    data.activeChecks[steamId].banType    = banType;
  }
  data.checkDoneRequests[steamId] = { result, by, banType, doneAt: new Date().toISOString() };
  const player = (data.players || []).find(p => p.steamId === steamId);
  const name   = player ? player.name    : steamId;
  const hwid   = player ? (player.hwid  || '') : '';
  const dc     = player ? (player.discordTag || '') : '';
  if (result === 'fail') {
    const hwidLow = hwid.toLowerCase();
    const already = data.bans.find(b => {
      if (banType === 'hwid')  return hwidLow && b.hwid === hwidLow;
      if (banType === 'steam') return steamId && b.steamId === steamId && !b.hwid;
      if (banType === 'both')  return (hwidLow && b.hwid === hwidLow) || (steamId && b.steamId === steamId);
      return false;
    });
    if (!already) {
      data.bans.push({
        id: Date.now().toString(), name, reason: 'Провалил проверку античита', bannedBy: by,
        date: new Date().toISOString(),
        steamId: (banType === 'steam' || banType === 'both') ? steamId : '',
        hwid:    (banType === 'hwid'  || banType === 'both') ? hwidLow : ''
      });
    }
    sendDiscordWebhook('⛔ Провал проверки — БАН', name + ' забанен', [
      { name: 'Игрок',    value: name },
      { name: 'Steam ID', value: steamId },
      { name: 'HWID',     value: hwid ? hwid.substring(0, 20) + '…' : '—' },
      { name: 'Тип бана', value: banType === 'both' ? 'Steam + HWID' : banType === 'steam' ? 'Steam ID' : 'HWID' },
      { name: 'Discord',  value: dc || '—' },
      { name: 'Кто',      value: by }
    ], 0xff0000);
    rconKick(steamId, 'Вы забанены: провалили проверку античита');
  } else {
    sendDiscordWebhook('✅ Проверка пройдена', name, [
      { name: 'Игрок', value: name }, { name: 'Steam ID', value: steamId },
      { name: 'Discord', value: dc || '—' }, { name: 'Проверял', value: by }
    ], 0x2ecc71);
  }
  saveData(data);
  res.json({ ok: true });
});
app.get('/api/check_done_pending/:steamId', (req, res) => {
  const data  = loadData();
  if (!data.checkDoneRequests) data.checkDoneRequests = {};
  const entry = data.checkDoneRequests[req.params.steamId];
  if (entry) res.json({ pending: true, result: entry.result, by: entry.by, banType: entry.banType });
  else res.json({ pending: false });
});
app.delete('/api/check_done_pending/:steamId', (req, res) => {
  const data = loadData();
  if (!data.checkDoneRequests) data.checkDoneRequests = {};
  delete data.checkDoneRequests[req.params.steamId];
  saveData(data); res.json({ ok: true });
});
app.get('/api/check_list', requireAuth, (req, res) => {
  const data = loadData();
  if (!data.activeChecks) data.activeChecks = {};
  const result = {};
  for (const [steamId, info] of Object.entries(data.activeChecks)) {
    const player = (data.players || []).find(p => p.steamId === steamId);
    result[steamId] = {
      ...info,
      playerName: player ? (player.name      || info.playerName || steamId) : (info.playerName || steamId),
      discordTag: player ? (player.discordTag || info.discordTag || '')      : (info.discordTag || ''),
      hwid:       player ? (player.hwid       || info.hwid       || '')      : (info.hwid       || '')
    };
  }
  res.json(result);
});
app.delete('/api/check_list/:steamId', requireAuth, (req, res) => {
  const data = loadData();
  if (!data.activeChecks) data.activeChecks = {};
  delete data.activeChecks[req.params.steamId];
  saveData(data);
  res.json({ ok: true });
});

// ── SCREENSHOT ────────────────────────────────────────────────────────────────
app.get('/api/screenshot_pending/:steamId', (req, res) => {
  const data = loadData();
  if (!data.screenshotRequests) data.screenshotRequests = {};
  res.json({ pending: !!data.screenshotRequests[req.params.steamId] });
});
app.delete('/api/screenshot_pending/:steamId', (req, res) => {
  const data = loadData();
  if (!data.screenshotRequests) data.screenshotRequests = {};
  delete data.screenshotRequests[req.params.steamId];
  saveData(data); res.json({ ok: true });
});
app.post('/api/screenshot_request/:steamId', requireAuth, (req, res) => {
  const data = loadData();
  if (!data.screenshotRequests) data.screenshotRequests = {};
  data.screenshotRequests[req.params.steamId] = { requestedAt: new Date().toISOString() };
  saveData(data); res.json({ ok: true });
});

// ── PLAYERS ───────────────────────────────────────────────────────────────────
app.get('/api/players', requireAuth, (req, res) => {
  const data = loadData(); res.json(data.players);
});
app.get('/api/players/:steamid', (req, res) => {
  const data   = loadData();
  const player = data.players.find(p => p.steamId === req.params.steamid);
  if (!player) return res.status(404).json({ error: 'Not found' });
  res.json(player);
});
app.get('/api/game/player/:steamid', (req, res) => {
  const steamId = req.params.steamid;
  const sig     = req.headers['x-game-sig'] || '';
  if (!verifyToken(steamId, steamId, sig))
    return res.status(403).json({ ok: false, error: 'invalid_signature' });
  const data   = loadData();
  const player = data.players.find(p => p.steamId === steamId);
  if (!player || !player.hwid || player.hwid.length < 8)
    return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, hwid: player.hwid, name: player.name || '' });
});

// ── DELETE /api/players/:steamid ──────────────────────────────────────────────
// Поддерживает два режима:
//   1. Плагин (x-game-sig) — только очищает HWID, не удаляет игрока
//   2. Админ (x-auth-token) — полное удаление игрока
app.delete('/api/players/:steamid', (req, res) => {
  const steamId = req.params.steamid;

  // Проверяем подпись от плагина
  const gameSig = req.headers['x-game-sig'] || '';
  const isPlugin = gameSig && verifyToken(steamId, steamId, gameSig);

  // Проверяем авторизацию админа
  const authToken = req.headers['x-auth-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  const isAdmin   = authToken && sessions.get(authToken);

  if (!isPlugin && !isAdmin) {
    console.warn(`[DIPRUST] DELETE /api/players/${steamId} — отклонён (нет подписи)`);
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const data = loadData();

  if (isPlugin) {
    // Плагин закрылся — только очищаем HWID, игрок остаётся в базе
    const player = data.players.find(p => p.steamId === steamId);
    if (player) {
      console.log(`[DIPRUST] Плагин: очищаем HWID для ${steamId}`);
      player.hwid     = '';
      player.lastSeen = new Date().toISOString();
      saveData(data);
    }
    activeHeartbeats.delete(steamId);
    return res.json({ ok: true });
  }

  // Админ — полное удаление
  const before = data.players.length;
  data.players  = data.players.filter(p => p.steamId !== steamId);
  if (data.players.length === before) return res.status(404).json({ error: 'Not found' });
  activeHeartbeats.delete(steamId);
  saveData(data);
  res.json({ ok: true });
});

app.delete('/api/game/player/:steamid', (req, res) => {
  const steamId = req.params.steamid;
  const sig     = req.headers['x-game-sig'] || '';
  if (!verifyToken(steamId, steamId, sig))
    return res.status(403).json({ ok: false, error: 'invalid_signature' });
  const data   = loadData();
  const player = data.players.find(p => p.steamId === steamId);
  if (player) { player.hwid = ''; player.lastSeen = new Date().toISOString(); saveData(data); }
  activeHeartbeats.delete(steamId);
  res.json({ ok: true });
});

// ── BANS ──────────────────────────────────────────────────────────────────────
app.post('/api/bans', requireAuth, (req, res) => {
  const { steamId, hwid, reason, bannedBy, name } = req.body;
  if (!hwid && !steamId) return res.status(400).json({ error: 'hwid or steamId required' });
  const data      = loadData();
  const hwidLower = (hwid || '').toLowerCase();
  const existing  = data.bans.find(b => {
    if (hwidLower && b.hwid === hwidLower) return true;
    if (!hwidLower && steamId && b.steamId === steamId && !b.hwid) return true;
    return false;
  });
  let playerName = name || 'Unknown';
  if (!name && steamId) { const p = data.players.find(pl => pl.steamId === steamId); if (p) playerName = p.name; }
  if (existing) {
    existing.reason   = reason    || existing.reason;
    existing.bannedBy = bannedBy  || existing.bannedBy;
    existing.date     = new Date().toISOString();
    existing.name     = playerName || existing.name;
  } else {
    data.bans.push({ id: Date.now().toString(), hwid: hwidLower || '', steamId: steamId || '', name: playerName, reason: reason || 'Нарушение правил', bannedBy: bannedBy || 'Admin', date: new Date().toISOString() });
  }
  saveData(data);
  sendDiscordWebhook('🚨 Бан', 'Игрок забанен через панель', [
    { name: 'Игрок',    value: (existing ? existing.name : name) || 'Unknown' },
    { name: 'Steam ID', value: steamId || '-' },
    { name: 'Причина',  value: reason || 'Нарушение правил' },
    { name: 'Кем',      value: bannedBy || 'Admin' }
  ], 0xe74c3c);
  if (steamId) rconKick(steamId, reason || 'Нарушение правил');
  res.status(200).json({ ok: true });
});
app.get('/api/bans', requireAuth, (req, res) => {
  const data = loadData();
  let changed = false;
  data.bans.forEach((b, i) => { if (!b.id) { b.id = 'legacy_' + i + '_' + Date.now(); changed = true; } });
  if (changed) saveData(data);
  res.json(data.bans);
});
app.delete('/api/bans/:id', requireAuth, (req, res) => {
  const data  = loadData();
  const reqId = req.params.id;
  data.bans.forEach((b, i) => { if (!b.id) b.id = 'legacy_' + i + '_' + Date.now(); });
  const idx = data.bans.findIndex(b =>
    b.id === reqId || b.steamId === reqId || (b.hwid && b.hwid === reqId)
  );
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const ban = data.bans[idx];
  data.bans.splice(idx, 1);
  saveData(data);
  sendDiscordWebhook('✅ Разбан', 'Разбанен через панель', [
    { name: 'Игрок',    value: ban.name || 'Unknown' },
    { name: 'Steam ID', value: ban.steamId || '-' }
  ], 0x2ecc71);
  res.json({ ok: true });
});

app.get('/api/stats', requireAuth, (req, res) => {
  const data = loadData();
  res.json({ totalBans: data.bans.length, totalPlayers: data.players.length });
});

app.listen(PORT, () => console.log('[DIPRUST Panel] Порт ' + PORT));
