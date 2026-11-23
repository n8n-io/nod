import { register } from 'tsx/esm/api';
import { trustSystemCertificates } from './system-certificates.mjs';

process.parentPort?.postMessage({ type: 'nod-starting', step: 'loading' });
trustSystemCertificates();
register();
await import('../../src/server/index.ts');
