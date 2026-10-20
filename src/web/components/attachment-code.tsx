import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { HighlighterCore, LanguageRegistration, ThemedToken } from 'shiki/core';

type Grammar = () => Promise<{ default: LanguageRegistration[] }>;

const grammars: Record<string, Grammar> = {
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
};

const aliases: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  jsonl: 'json',
  ndjson: 'json',
  jsonc: 'json',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  h: 'c',
  cpp: 'c',
  cc: 'c',
  hpp: 'c',
  'c++': 'c',
  cs: 'csharp',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  console: 'shellscript',
  htm: 'html',
  svg: 'xml',
  yml: 'yaml',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini',
  patch: 'diff',
  gql: 'graphql',
  docker: 'dockerfile',
};

export function codeLanguage(value: string) {
  const name = value.toLowerCase();
  if (name === 'dockerfile' || name.endsWith('/dockerfile')) return 'dockerfile';
  const key = /\.([a-z0-9+]+)$/.exec(name)?.[1] ?? name;
  const language = aliases[key] ?? key;
  return language in grammars ? language : null;
}

let highlighter: Promise<HighlighterCore> | undefined;

async function tokenize(code: string, language: string) {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] =
      await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('shiki/themes/github-light-default.mjs'),
        import('shiki/themes/github-dark-default.mjs'),
      ]);
    return createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  const core = await highlighter;
  if (!core.getLoadedLanguages().includes(language))
    await core.loadLanguage((await grammars[language]()).default);
  return core.codeToTokens(code, {
    lang: language,
    themes: { light: 'github-light-default', dark: 'github-dark-default' },
    defaultColor: false,
  }).tokens;
}

export function formatJson(text: string) {
  const value = text.trim();
  if (value.length < 120 || value.length > 1_000_000 || value.includes('\n')) return text;
  try {
    JSON.parse(value);
  } catch {
    return text;
  }
  let output = '';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  const line = () => `\n${'  '.repeat(depth)}`;
  for (const char of value) {
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      output += char;
    } else if (char === '{' || char === '[') {
      depth += 1;
      output += char + line();
    } else if (char === '}' || char === ']') {
      depth -= 1;
      output += line() + char;
    } else if (char === ',') output += `,${line()}`;
    else if (char === ':') output += ': ';
    else if (!/\s/.test(char)) output += char;
  }
  return output.replace(/([[{])\n\s*([\]}])/g, '$1$2');
}

export function CodeView({
  text,
  language,
  wrap = false,
  numbers = true,
}: {
  text: string;
  language: string | null;
  wrap?: boolean;
  numbers?: boolean;
}) {
  const lines = useMemo(() => text.replace(/\r?\n$/, '').split(/\r?\n/), [text]);
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  const highlight = Boolean(language) && text.length <= 300_000 && lines.length <= 8_000;
  useEffect(() => {
    setTokens(null);
    if (!highlight || !language) return;
    let active = true;
    void tokenize(text, language)
      .then((value) => {
        if (active) setTokens(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [text, language, highlight]);
  if (lines.length > 20_000)
    return (
      <pre className="artifact-code is-plain" tabIndex={0} data-artifact-scroll="">
        {text}
      </pre>
    );
  return (
    <pre
      className={`artifact-code${wrap ? ' is-wrapped' : ''}${numbers ? ' has-numbers' : ''}`}
      style={{ '--artifact-gutter': `${String(lines.length).length}ch` } as CSSProperties}
      tabIndex={0}
      data-artifact-scroll=""
    >
      <code>
        {lines.map((line, index) => (
          <span className="artifact-code-line" key={index}>
            {tokens?.[index]
              ? tokens[index].map((token, position) => (
                  <span key={position} style={token.htmlStyle as CSSProperties}>
                    {token.content}
                  </span>
                ))
              : line}
            {'\n'}
          </span>
        ))}
      </code>
    </pre>
  );
}
