import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(resolve(directory, entry.name))
          : [resolve(directory, entry.name)],
      ),
    )
  ).flat();
}

const sourceRoot = resolve('src');
const failures = [];
const vendor =
  /^(?:@earendil-works\/|@composio\/|@chat-adapter\/|@whiskeysockets\/|@1password\/|chat$|agent-browser$)/;
for (const file of await files(sourceRoot)) {
  if (!/\.[cm]?tsx?$/.test(file)) continue;
  const name = relative(sourceRoot, file).replaceAll('\\', '/');
  const layer = name.split('/')[0];
  const source = ts.createSourceFile(
    file,
    await readFile(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const problem = (message) => failures.push(`${name}: ${message}`);
  function inspect(node) {
    const specifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier;
    const dynamic =
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0];
    const literal = specifier || dynamic;
    if (literal && ts.isStringLiteralLike(literal)) {
      const dependency = literal.text;
      if (vendor.test(dependency) && layer !== 'providers')
        problem(`Vendor dependency ${dependency} belongs in providers.`);
      if (dependency.startsWith('.')) {
        const target = relative(sourceRoot, resolve(dirname(file), dependency))
          .replaceAll('\\', '/')
          .split('/')[0];
        const allowed = {
          web: ['web', 'shared'],
          shared: ['shared'],
          ports: ['ports', 'shared'],
          runtime: ['runtime', 'ports', 'shared'],
          providers: ['providers', 'ports', 'shared'],
          server:
            name === 'server/composition.ts'
              ? ['server', 'runtime', 'providers', 'ports', 'shared']
              : ['server', 'ports', 'shared'],
        }[layer];
        if (!allowed?.includes(target))
          problem(`Import of ${dependency} crosses the ${layer} boundary.`);
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.getText(source) === 'process.env' &&
      ['runtime', 'ports', 'shared', 'web'].includes(layer)
    )
      problem('Environment configuration belongs in server composition.');
    ts.forEachChild(node, inspect);
  }
  inspect(source);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log('Architecture boundaries passed.');
