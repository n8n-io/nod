import { main } from './commands.ts';
import { parseArgs } from './options.ts';

try {
  await main(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
