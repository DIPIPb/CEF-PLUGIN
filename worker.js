// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Cloudflare Worker — XXL Clan Apply
//  • Проксирует заявки в Discord
//  • Лимит: 1 заявка с 1 IP раз в 30 минут
//  KV namespace: XXL_RATELIMIT (привязать в настройках)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1489991982305775657/G6Y5zIkLcDUO8Sa5kyK8SzRUeHHhP9Kwqz0bYywnsaQhr7Jhy7rqy8b5983BAb55fveJ";
const COOLDOWN_SEC = 30 * 60; // 30 минут

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export default {
  async fetch(request, env) {

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    // Получаем IP
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const kvKey = `ratelimit:${ip}`;

    // Проверяем KV на cooldown
    const lastSubmit = await env.XXL_RATELIMIT.get(kvKey);
    if (lastSubmit) {
      const elapsed = Math.floor(Date.now() / 1000) - parseInt(lastSubmit);
      const remaining = COOLDOWN_SEC - elapsed;
      if (remaining > 0) {
        const mins = Math.ceil(remaining / 60);
        return json({
          error: `⏳ Ты уже подавал заявку. Подождите ещё ${mins} мин.`
        }, 429);
      }
    }

    // Парсим данные
    let data;
    try {
      data = await request.json();
    } catch {
      return json({ error: "Некорректный запрос" }, 400);
    }

    const { age, hours, nick, name, discord, priv, role, extra } = data;

    // Базовая валидация
    if (!age || !hours || !nick || !name || !discord || !role) {
      return json({ error: "Заполни все обязательные поля" }, 400);
    }

    // Формируем embed для Discord
    const payload = {
      embeds: [{
        title: "📋 Новая заявка в клан XXL",
        color: 0xFF4500,
        fields: [
          { name: "👤 Имя",         value: String(name),    inline: true },
          { name: "🎮 Ник в игре",  value: String(nick),    inline: true },
          { name: "🗓️ Возраст",    value: age + " лет",    inline: true },
          { name: "⏱️ Часов в Rust",value: String(hours),   inline: true },
          { name: "⭐ Привилегия",  value: String(priv),    inline: true },
          { name: "🔧 Должность",   value: String(role),    inline: true },
          { name: "💬 Discord",     value: String(discord), inline: false },
          { name: "📝 Дополнительно", value: String(extra || "Не указано"), inline: false },
          { name: "🌐 IP",          value: ip,              inline: true },
        ],
        footer: { text: "XXL Clan Recruitment" },
        timestamp: new Date().toISOString(),
      }],
    };

    // Отправляем в Discord
    const discordRes = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!discordRes.ok && discordRes.status !== 204) {
      return json({ error: "Ошибка Discord: " + discordRes.status }, 502);
    }

    // Сохраняем время отправки в KV (TTL = 30 минут)
    await env.XXL_RATELIMIT.put(kvKey, Math.floor(Date.now() / 1000).toString(), {
      expirationTtl: COOLDOWN_SEC,
    });

    return json({ ok: true });
  },
};
