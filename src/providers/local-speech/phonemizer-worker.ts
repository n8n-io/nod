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
    (request.voice !== 'en-us' && request.voice !== 'en-gb')
  )
    throw new Error('input');
  const engine = await createEspeak({ languages: ['en'] });
  engine.setVoice(request.voice);
  const phonemes = request.text
    .split(/([;:,!?¡¿—…"«»“”(){}\[\]\n]+|(?<!\d)\.|\.(?!\d))/u)
    .map((part, index) => (index % 2 ? part : engine.phonemes(part).replace(/\n/g, ' ')))
    .join('')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .trim();
  engine.dispose();
  process.stdout.write(JSON.stringify(phonemes), () => process.exit(0));
} catch {
  process.exit(1);
}
