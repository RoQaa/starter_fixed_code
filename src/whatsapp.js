const config = require('./config');

async function sendWhatsAppText(to, body, phoneNumberId = config.whatsappPhoneNumberId) {
  const url = `${config.graphApiBase}/${config.graphApiVersion}/${phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.metaAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    throw new Error(`WhatsApp send failed (HTTP ${res.status}, code ${e.code ?? '?'}): ${e.message ?? 'unknown error'}`);
  }
  return data;
}

module.exports = { sendWhatsAppText };
