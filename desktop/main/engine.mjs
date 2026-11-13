import { register } from 'tsx/esm/api';
import { trustSystemCertificates } from './system-certificates.mjs';

trustSystemCertificates();
register();
await import('../../src/server/index.ts');
