import { getCACertificates, setDefaultCACertificates } from 'node:tls';

export function trustSystemCertificates(tls = { getCACertificates, setDefaultCACertificates }) {
  const system = tls.getCACertificates('system');
  if (!system.length) return;
  tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...system])]);
}
