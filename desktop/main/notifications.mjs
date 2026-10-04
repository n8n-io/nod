import { setTimeout as delay } from 'node:timers/promises';

function redactPreview(value, secrets) {
  let text = value;
  for (const secret of secrets)
    if (typeof secret === 'string' && secret.length >= 8)
      for (const variant of [secret, encodeURIComponent(secret)])
        text = text.replaceAll(variant, '[redacted]');
  return text;
}

export function assistantNotificationPreview(message, secrets = []) {
  function plain(value) {
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    const source = redactPreview(value, secrets).slice(0, 16_384);
    const text = source
      .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
        if (!entity.startsWith('#')) return entities[entity.toLowerCase()] || match;
        const code =
          entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      })
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
      .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
      .replace(/^\s*\[[^\]\n]+\]:[^\n]*$/gm, '')
      .replace(/!?\[([^\]\n]*)\]\([^\n)]*\)/g, '$1')
      .replace(/!?\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/\bhttps?:\/\/[^\s<>()]+/gi, (url) => {
        try {
          return new URL(url).hostname;
        } catch {
          return '';
        }
      })
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, '')
      .replace(/(\*{1,3}|_{1,3}|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\\([\\`*_{}\[\]()#+.!-])/g, '$1')
      .replace(
        /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069]/g,
        '',
      );
    return redactPreview(text, secrets).replace(/\s+/g, ' ').trim();
  }
  let text = plain(typeof message?.text === 'string' ? message.text : '');
  if (!text) {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const name =
      attachments.length === 1 && typeof attachments[0]?.name === 'string'
        ? plain(attachments[0].name)
        : '';
    text =
      attachments.length > 1
        ? `Shared ${attachments.length} attachments.`
        : name
          ? `Shared ${name}`
          : attachments.length
            ? 'Shared an attachment.'
            : 'You have a new message from Otto.';
  }
  const characters = Array.from(text);
  return characters.length > 240 ? `${characters.slice(0, 239).join('').trimEnd()}…` : text;
}

export function isQuietTime(preferences, now = new Date()) {
  if (!preferences.quietHoursEnabled) return false;
  const current = new Intl.DateTimeFormat('en-GB', {
    timeZone: preferences.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const { quietStart, quietEnd } = preferences;
  return (
    quietStart !== quietEnd &&
    (quietStart < quietEnd
      ? current >= quietStart && current < quietEnd
      : current >= quietStart || current < quietEnd)
  );
}

export function createReadinessNotice({ notify }) {
  let state = {};
  let observedPreparation = false;
  let consumed = false;
  let pending;

  function eligible() {
    return (
      observedPreparation &&
      !consumed &&
      state.runtimePhase === 'ready' &&
      state.enabled &&
      !state.foreground &&
      !state.quitting &&
      (!state.completed || state.engineReady)
    );
  }

  function update(value) {
    state = value;
    if (state.guided && state.runtimePhase === 'preparing') observedPreparation = true;
    if (state.engineReady && state.foreground) consumed = true;
    if (!eligible()) return Promise.resolve(false);
    if (pending) return pending;
    pending = Promise.resolve()
      .then(() => eligible() && notify(eligible))
      .then((handled) => {
        if (handled) consumed = true;
        return Boolean(handled);
      })
      .catch(() => false)
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }

  return { update };
}

export function watchAssistantMessages({ request, onMessage, retryMs = 1000 }) {
  const controller = new AbortController();
  const seen = new Set();
  let initialized = false;
  let threadId;
  async function refresh() {
    const response = await request('/api/state', {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Messages are unavailable.');
    const body = await response.json();
    if (typeof body.threadId !== 'string' || !body.threadId || !Array.isArray(body.messages))
      throw new Error('Messages are unavailable.');
    if (threadId !== body.threadId) {
      initialized = false;
      seen.clear();
      threadId = body.threadId;
    }
    let received;
    for (const message of body.messages) {
      if (typeof message?.id !== 'string' || !['user', 'assistant'].includes(message.role))
        continue;
      if (initialized && !seen.has(message.id) && message.role === 'assistant') received = message;
      seen.add(message.id);
    }
    while (seen.size > 1000) seen.delete(seen.values().next().value);
    initialized = true;
    if (received && !controller.signal.aborted) onMessage(received, threadId);
  }
  async function subscribe() {
    while (!controller.signal.aborted) {
      let reader;
      try {
        const response = await request('/api/events', {
          signal: controller.signal,
          redirect: 'error',
        });
        if (!response.ok || !response.body) throw new Error('Updates are unavailable.');
        reader = response.body.getReader();
        await refresh();
        let buffer = '';
        const decoder = new TextDecoder();
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n');
          if (buffer.length > 256 * 1024) throw new Error('Update is too large.');
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (!data) continue;
            let event;
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }
            if (event.type === 'refresh') await refresh();
          }
        }
      } catch {
      } finally {
        await reader?.cancel().catch(() => {});
      }
      if (!controller.signal.aborted)
        await delay(retryMs, undefined, { signal: controller.signal }).catch(() => {});
    }
  }
  void subscribe();
  return () => controller.abort();
}
