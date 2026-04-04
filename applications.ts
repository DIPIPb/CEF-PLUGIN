import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, applicationsTable, settingsTable } from "@workspace/db";
import { SubmitApplicationBody } from "@workspace/api-zod";

const router: IRouter = Router();

function getClientIp(req: import("express").Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return first.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

router.get("/applications/check", async (req, res): Promise<void> => {
  const ip = getClientIp(req);
  const existing = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.ip, ip))
    .limit(1);

  res.json({ alreadySubmitted: existing.length > 0 });
});

router.post("/applications", async (req, res): Promise<void> => {
  const ip = getClientIp(req);

  const existing = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.ip, ip))
    .limit(1);

  if (existing.length > 0) {
    res.status(409).json({ error: "Заявка с этого IP уже была отправлена" });
    return;
  }

  const parsed = SubmitApplicationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const webhookSetting = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, "discord_webhook_url"))
    .limit(1);

  if (webhookSetting.length === 0) {
    res.status(503).json({ error: "Discord webhook не настроен" });
    return;
  }

  const webhookUrl = webhookSetting[0].value;
  const data = parsed.data;

  const embed = {
    title: "📋 Новая заявка в клан XXL",
    color: 0xdd0000,
    fields: [
      { name: "1) Привилегия", value: data.privilege || "Нет", inline: true },
      { name: "2) Возраст", value: data.age, inline: true },
      { name: "3) Часов в игре", value: data.hours, inline: true },
      { name: "4) Ник в игре", value: data.gameNick, inline: true },
      { name: "5) Имя", value: data.name, inline: true },
      { name: "6) Должность", value: data.role, inline: true },
      { name: "7) Discord", value: data.discord, inline: false },
    ],
    footer: { text: "XXL Clan Recruitment" },
    timestamp: new Date().toISOString(),
  };

  const discordRes = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "XXL Clan Bot", embeds: [embed] }),
  });

  if (!discordRes.ok) {
    req.log.error({ status: discordRes.status }, "Discord webhook failed");
    res.status(502).json({ error: "Ошибка отправки в Discord" });
    return;
  }

  await db.insert(applicationsTable).values({
    ip,
    privilege: data.privilege ?? "",
    age: data.age,
    hours: data.hours,
    gameNick: data.gameNick,
    name: data.name,
    role: data.role,
    discord: data.discord,
  });

  res.status(201).json({ success: true });
});

export default router;
