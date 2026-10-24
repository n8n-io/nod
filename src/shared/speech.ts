export interface SpeechVoice {
  id: string;
  name: string;
  description: string;
  engine: 'ElevenLabs' | 'Kokoro' | 'OpenAI' | 'Local';
  language?: string;
}

export const speechVoices = [
  {
    id: 'local:af_heart',
    name: 'Heart',
    description: 'American English · local',
    engine: 'Local',
    language: 'en-US',
  },
  {
    id: 'local:af_bella',
    name: 'Bella',
    description: 'American English · local',
    engine: 'Local',
    language: 'en-US',
  },
  {
    id: 'local:bf_emma',
    name: 'Emma',
    description: 'British English · local',
    engine: 'Local',
    language: 'en-GB',
  },
  {
    id: 'local:bm_george',
    name: 'George',
    description: 'British English · local',
    engine: 'Local',
    language: 'en-GB',
  },
  {
    id: 'local:pf_dora',
    name: 'Dora',
    description: 'Brazilian Portuguese · local',
    engine: 'Local',
    language: 'pt-BR',
  },
  {
    id: 'local:pm_alex',
    name: 'Alex',
    description: 'Brazilian Portuguese · local',
    engine: 'Local',
    language: 'pt-BR',
  },
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
  {
    id: 'kokoro:af_heart',
    name: 'Heart',
    description: 'American English',
    engine: 'Kokoro',
    language: 'en-US',
  },
  {
    id: 'kokoro:af_bella',
    name: 'Bella',
    description: 'American English',
    engine: 'Kokoro',
    language: 'en-US',
  },
  {
    id: 'kokoro:bf_emma',
    name: 'Emma',
    description: 'British English',
    engine: 'Kokoro',
    language: 'en-GB',
  },
  {
    id: 'kokoro:bm_george',
    name: 'George',
    description: 'British English',
    engine: 'Kokoro',
    language: 'en-GB',
  },
  { id: 'openai:coral', name: 'Coral', description: 'Warm and friendly', engine: 'OpenAI' },
  { id: 'openai:marin', name: 'Marin', description: 'Clear and natural', engine: 'OpenAI' },
  { id: 'openai:cedar', name: 'Cedar', description: 'Calm and grounded', engine: 'OpenAI' },
  { id: 'openai:sage', name: 'Sage', description: 'Gentle and thoughtful', engine: 'OpenAI' },
] as const satisfies readonly SpeechVoice[];

export type SpeechVoiceId = (typeof speechVoices)[number]['id'];
