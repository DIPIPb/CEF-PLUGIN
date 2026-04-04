import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, settingsTable } from "@workspace/db";
import { SaveWebhookSettingsBody } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/settings/webhook", async (_req, res): Promise<void> => {
  const row = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, "discord_webhook_url"))
    .limit(1);

  if (row.length === 0) {
    res.json({ configured: false, maskedUrl: null });
    return;
  }

  const url = row[0].value;
  const masked = url.slice(0, 40) + "..." + url.slice(-6);
  res.json({ configured: true, maskedUrl: masked });
});

router.post("/settings/webhook", async (req, res): Promise<void> => {
  const parsed = SaveWebhookSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const url = parsed.data.url;
  if (!url.startsWith("https://discord.com/api/webhooks/") && !url.startsWith("https://discordapp.com/api/webhooks/")) {
    res.status(400).json({ error: "Это должен быть Discord Webhook URL" });
    return;
  }

  await db
    .insert(settingsTable)
    .values({ key: "discord_webhook_url", value: url })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: { value: url },
    });

  const masked = url.slice(0, 40) + "..." + url.slice(-6);
  res.json({ configured: true, maskedUrl: masked });
});

export default router;
