import { createHash } from 'node:crypto';
import { list } from 'tar';

export async function imageIdentities(file, references, { architecture, revision }) {
  const entries = new Map();
  await list({
    file,
    filter: (path, entry) =>
      entry.type === 'File' &&
      entry.size <= 1024 ** 2 &&
      (['index.json', 'manifest.json'].includes(path) ||
        /^blobs\/sha256\/[a-f0-9]{64}$/.test(path)),
    onReadEntry: (entry) => {
      const chunks = [];
      entry.on('data', (chunk) => chunks.push(chunk));
      entry.on('end', () => entries.set(entry.path, Buffer.concat(chunks)));
    },
  });
  const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const blob = (digest) => {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid image digest.');
    const bytes = entries.get(`blobs/sha256/${digest.slice(7)}`);
    if (!bytes || hash(bytes) !== digest) throw new Error('Image content digest does not match.');
    return JSON.parse(bytes);
  };
  const containsConfig = (digest, config, depth = 0) => {
    if (depth > 8) throw new Error('Image index nesting is too deep.');
    const value = blob(digest);
    return (
      value.config?.digest === config ||
      value.manifests?.some((child) => containsConfig(child.digest, config, depth + 1))
    );
  };
  const manifest = JSON.parse(entries.get('manifest.json'));
  const index = JSON.parse(entries.get('index.json'));
  const familiar = (reference) => reference?.replace(/^docker\.io\/library\//, '');
  return references.map((reference) => {
    const saved = manifest.filter((image) =>
      image.RepoTags?.some((tag) => familiar(tag) === reference),
    );
    const targets = index.manifests.filter(
      (image) => familiar(image.annotations?.['io.containerd.image.name']) === reference,
    );
    if (saved.length !== 1 || targets.length !== 1)
      throw new Error('Archive must identify each bundled image exactly once.');
    const bytes = entries.get(saved[0].Config);
    if (!bytes) throw new Error('Archive image configuration is missing.');
    const config = hash(bytes);
    const value = blob(config);
    const target = targets[0].digest;
    if (
      value.os !== 'linux' ||
      value.architecture !== architecture ||
      value.config?.Labels?.['org.opencontainers.image.revision'] !== revision ||
      !containsConfig(target, config)
    )
      throw new Error('Archive image does not match its platform, source or reference.');
    return { reference, config, target };
  });
}
