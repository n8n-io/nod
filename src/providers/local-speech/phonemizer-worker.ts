import { createEspeak } from '@spelling-creator/spellophone';

if (process.send && !process.connected) process.exit(0);
process.once('disconnect', () => process.exit(0));
try {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 10_000) process.exit(1);
  }
  const request = JSON.parse(input) as { text?: unknown; voice?: unknown };
  if (
    typeof request?.text !== 'string' ||
    request.text.length > 2_000 ||
    typeof request.voice !== 'string' ||
    !['en-us', 'en-gb', 'es', 'fr-fr', 'hi', 'it'].includes(request.voice)
  )
    throw new Error('input');
  const engine = await createEspeak({ languages: ['en'] });
  engine.setVoice(request.voice);
  const english = request.voice.startsWith('en-');
  let phonemes = (english ? request.text : request.text.replace(/[।॥]/g, '.'))
    .split(/([;:,!?¡¿—…"«»“”(){}\[\]\n]+|(?<!\d)\.|\.(?!\d))/u)
    .map((part, index) => {
      if (index % 2) return part;
      const phones = engine.phonemes(part, english ? undefined : { separator: '^', tie: true });
      return (english ? phones : phones.replace(/\([a-z]+(?:-[a-z]+)*\)/g, '')).replace(/\n/g, ' ');
    })
    .join('')
    .trim();
  if (english)
    phonemes = phonemes.replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l');
  else {
    for (const [source, target] of Object.entries({
      'a^ɪ': 'I',
      'a^ʊ': 'W',
      'd^z': 'ʣ',
      'd^ʒ': 'ʤ',
      'e^ɪ': 'A',
      'o^ʊ': 'O',
      'ə^ʊ': 'Q',
      's^s': 'S',
      't^s': 'ʦ',
      't^ʃ': 'ʧ',
      'ɔ^ɪ': 'Y',
    }))
      phonemes = phonemes.replaceAll(source, target);
    phonemes = phonemes.replace(/[\^-]/g, '');
  }
  engine.dispose();
  process.stdout.write(JSON.stringify(phonemes), () => process.exit(0));
} catch {
  process.exit(1);
}
