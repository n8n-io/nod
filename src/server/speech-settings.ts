import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { SpeechService } from './speech.ts';
import type { LocalSpeechControls } from '../ports/speech.ts';
import type { createPreferencesStore } from './preferences.ts';

const previews: Record<string, string> = {
  en: 'Hello, I’m nod. Here’s how I sound. What would you like to work on?',
  pt: 'Olá, sou o nod. Esta é a minha voz. Em que posso ajudar?',
  es: 'Hola, soy nod. Así suena mi voz. ¿En qué puedo ayudarte?',
  fr: 'Bonjour, je suis nod. Voici ma voix. Comment puis-je vous aider ?',
  de: 'Hallo, ich bin nod. So klingt meine Stimme. Wobei kann ich helfen?',
  it: 'Ciao, sono nod. Questa è la mia voce. Come posso aiutarti?',
  ja: 'こんにちは、nodです。これが私の声です。何をお手伝いしましょうか。',
  zh: '你好，我是nod。这是我的声音。有什么我可以帮你的吗？',
  hi: 'नमस्ते, मैं nod हूँ। मेरी आवाज़ ऐसी है। मैं आपकी क्या मदद कर सकता हूँ?',
  ar: 'مرحباً، أنا نود. هذا هو صوتي. كيف يمكنني مساعدتك؟',
  ko: '안녕하세요, 저는 nod입니다. 제 목소리는 이렇습니다. 무엇을 도와드릴까요?',
  ru: 'Здравствуйте, я nod. Так звучит мой голос. Чем я могу помочь?',
};

export function registerSpeechSettings(
  app: FastifyInstance,
  options: {
    speech: SpeechService;
    preferences: ReturnType<typeof createPreferencesStore>;
    local?: LocalSpeechControls;
    inputFormat?: (voice: string | null) => 'wav' | undefined;
  },
) {
  const { speech, preferences } = options;
  let preview: AbortController | undefined;
  const preparations = new Set<AbortController>();
  async function current(reply: FastifyReply, force = false) {
    reply.header('Cache-Control', 'no-store');
    const controller = new AbortController();
    const stop = () => controller.abort();
    reply.raw.once('close', stop);
    let voicesError: string | undefined;
    try {
      await speech.refreshVoices(controller.signal, force);
    } catch {
      controller.signal.throwIfAborted();
      voicesError = 'ElevenLabs voices could not be loaded. Try again.';
    } finally {
      reply.raw.off('close', stop);
    }
    const saved = await preferences.get();
    const transcriptionFormat = options.inputFormat?.(saved.speechVoice);
    return {
      transcription: saved.speechVoice?.startsWith('local:')
        ? options.local?.transcriptionStatus().state === 'ready'
        : speech.transcriptionConfigured,
      synthesis: speech.configured,
      voices: speech.voices,
      speechVoice: saved.speechVoice,
      defaultVoice: speech.defaultVoice,
      speechReply: saved.speechReply,
      ...(voicesError ? { voicesError } : {}),
      ...(options.local
        ? { local: options.local.status(), localInput: options.local.transcriptionStatus() }
        : {}),
      ...(transcriptionFormat ? { transcriptionFormat } : {}),
    };
  }
  app.get('/api/speech', async (_request, reply) => current(reply));
  app.post('/api/speech/voices/refresh', async (request, reply) => {
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return current(reply, true);
  });
  app.post('/api/speech/prepare', async (request, reply) => {
    const { inputOnly } = z
      .object({ locale: z.string().max(35).optional(), inputOnly: z.boolean().optional() })
      .strict()
      .parse(request.body ?? {});
    const saved = await preferences.get();
    if (inputOnly && !saved.speechVoice?.startsWith('local:') && speech.transcriptionConfigured)
      return { transcription: true, transcriptionFormat: options.inputFormat?.(saved.speechVoice) };
    if (!options.local) return reply.code(404).send({ error: 'On-device audio is unavailable.' });
    const controller = new AbortController();
    preparations.add(controller);
    const stop = () => controller.abort();
    reply.raw.once('close', stop);
    try {
      if (inputOnly) await options.local.prepareTranscription(controller.signal);
      else await options.local.prepare(controller.signal);
      controller.signal.throwIfAborted();
      return {
        local: options.local.status(),
        localInput: options.local.transcriptionStatus(),
        transcription: true,
        transcriptionFormat: options.inputFormat?.(saved.speechVoice),
      };
    } finally {
      preparations.delete(controller);
      reply.raw.off('close', stop);
    }
  });
  app.post('/api/speech/preview', async (request, reply) => {
    const { voice, locale } = z
      .object({
        voice: z.string().max(128).nullable(),
        locale: z.string().max(35).optional(),
      })
      .strict()
      .parse(request.body);
    const chosen = speech.voices.find((item) => item.id === (voice ?? speech.defaultVoice));
    if (!chosen) return reply.code(400).send({ error: 'Choose an available voice.' });
    if (preview) return reply.code(409).send({ error: 'A voice preview is already playing.' });
    const controller = new AbortController();
    preview = controller;
    const stop = () => controller.abort();
    reply.raw.once('close', stop);
    try {
      const language = (chosen.language ?? locale ?? 'en').toLowerCase().split('-')[0];
      const audio = await speech.synthesize(previews[language] ?? previews.en, controller.signal, {
        voice: chosen.id,
      });
      return reply.header('Cache-Control', 'no-store').type(audio.mimeType).send(audio.bytes);
    } finally {
      reply.raw.off('close', stop);
      if (preview === controller) preview = undefined;
    }
  });
  app.addHook('preClose', async () => {
    preview?.abort();
    for (const controller of preparations) controller.abort();
  });
}
