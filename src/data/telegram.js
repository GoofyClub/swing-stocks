// =============================================================================
// Telegram helper — works in the browser (the settings "Test" button) and in
// Node workers (entry/exit alerts). Uses fetch; the Telegram Bot API sends CORS
// headers so a browser call from the settings page works.
//
// To get credentials: message @BotFather to create a bot (get the token), then
// message your bot once and read your chat id from
// https://api.telegram.org/bot<token>/getUpdates (result[].message.chat.id).
// =============================================================================

export async function sendTelegram(botToken, chatId, text, fetchImpl = globalThis.fetch) {
  if (!botToken || !chatId) throw new Error('Telegram bot token and chat id are required.');
  const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    throw new Error(`Telegram API error: ${json?.description || res.status}`);
  }
  return json.result;
}
