export interface SpeechVoice {
  id: string;
  name: string;
  description: string;
  engine: 'ElevenLabs' | 'Kokoro' | 'OpenAI' | 'Local';
  language?: string;
  source?: 'elevenlabs' | 'openrouter' | 'openai' | 'local';
}

const localVoices = [
  { id: 'af_heart', name: 'Heart', description: 'American English', language: 'en-US' },
  { id: 'af_bella', name: 'Bella', description: 'American English', language: 'en-US' },
  { id: 'bf_emma', name: 'Emma', description: 'British English', language: 'en-GB' },
  { id: 'bm_george', name: 'George', description: 'British English', language: 'en-GB' },
  { id: 'pf_dora', name: 'Dora', description: 'Brazilian Portuguese', language: 'pt-BR' },
  { id: 'pm_alex', name: 'Alex', description: 'Brazilian Portuguese', language: 'pt-BR' },
  { id: 'ef_dora', name: 'Dora', description: 'Spanish', language: 'es' },
  { id: 'em_alex', name: 'Alex', description: 'Spanish', language: 'es' },
  { id: 'ff_siwis', name: 'Siwis', description: 'French', language: 'fr-FR' },
  { id: 'hf_alpha', name: 'Alpha', description: 'Hindi', language: 'hi-IN' },
  { id: 'hm_omega', name: 'Omega', description: 'Hindi', language: 'hi-IN' },
  { id: 'if_sara', name: 'Sara', description: 'Italian', language: 'it-IT' },
  { id: 'im_nicola', name: 'Nicola', description: 'Italian', language: 'it-IT' },
] as const;

const builtInSpeechVoices = [
  ...localVoices.map((voice) => ({
    ...voice,
    id: `local:${voice.id}` as const,
    engine: 'Local' as const,
  })),
  {
    id: 'elevenlabs:sarah',
    name: 'Sarah',
    description: 'Warm and conversational',
    engine: 'ElevenLabs',
  },
  {
    id: 'elevenlabs:brian',
    name: 'Brian',
    description: 'Deep and reassuring',
    engine: 'ElevenLabs',
  },
  {
    id: 'elevenlabs:alice',
    name: 'Alice',
    description: 'Clear and engaging',
    engine: 'ElevenLabs',
  },
  {
    id: 'elevenlabs:george',
    name: 'George',
    description: 'Warm and expressive',
    engine: 'ElevenLabs',
  },
  ...localVoices.map((voice) => ({
    ...voice,
    id: `kokoro:${voice.id}` as const,
    engine: 'Kokoro' as const,
  })),
  {
    id: 'kokoro:jf_alpha',
    name: 'Alpha',
    description: 'Japanese',
    engine: 'Kokoro',
    language: 'ja-JP',
  },
  {
    id: 'kokoro:jm_kumo',
    name: 'Kumo',
    description: 'Japanese',
    engine: 'Kokoro',
    language: 'ja-JP',
  },
  {
    id: 'kokoro:zf_xiaobei',
    name: 'Xiaobei',
    description: 'Mandarin Chinese',
    engine: 'Kokoro',
    language: 'zh-CN',
  },
  {
    id: 'kokoro:zm_yunxi',
    name: 'Yunxi',
    description: 'Mandarin Chinese',
    engine: 'Kokoro',
    language: 'zh-CN',
  },
  { id: 'openai:coral', name: 'Coral', description: 'Warm and friendly', engine: 'OpenAI' },
  { id: 'openai:marin', name: 'Marin', description: 'Clear and natural', engine: 'OpenAI' },
  { id: 'openai:cedar', name: 'Cedar', description: 'Calm and grounded', engine: 'OpenAI' },
  { id: 'openai:sage', name: 'Sage', description: 'Gentle and thoughtful', engine: 'OpenAI' },
  { id: 'openai:alloy', name: 'Alloy', description: 'Multilingual', engine: 'OpenAI' },
  { id: 'openai:ash', name: 'Ash', description: 'Multilingual', engine: 'OpenAI' },
  { id: 'openai:ballad', name: 'Ballad', description: 'Multilingual', engine: 'OpenAI' },
  { id: 'openai:echo', name: 'Echo', description: 'Multilingual', engine: 'OpenAI' },
  { id: 'openai:fable', name: 'Fable', description: 'Multilingual', engine: 'OpenAI' },
  { id: 'openai:nova', name: 'Nova', description: 'Multilingual', engine: 'OpenAI' },
  { id: 'openai:onyx', name: 'Onyx', description: 'Multilingual', engine: 'OpenAI' },
  { id: 'openai:shimmer', name: 'Shimmer', description: 'Multilingual', engine: 'OpenAI' },
  { id: 'openai:verse', name: 'Verse', description: 'Multilingual', engine: 'OpenAI' },
] as const satisfies readonly SpeechVoice[];

export const speechVoices = builtInSpeechVoices.map(
  (voice) =>
    ({
      ...voice,
      source:
        voice.engine === 'Local' ? 'local' : voice.engine === 'OpenAI' ? 'openai' : 'openrouter',
    }) satisfies SpeechVoice,
);

export function isSpeechVoiceId(id: string) {
  return (
    speechVoices.some((voice) => voice.id === id) ||
    /^elevenlabs-direct:[A-Za-z0-9_-]{1,64}$/.test(id)
  );
}
