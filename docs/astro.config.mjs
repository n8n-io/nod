import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import { defineHastPlugin, defineMdastPlugin } from 'satteri';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';

const site = process.env.DOCS_SITE || 'https://nod-docs.pages.dev';
const base = process.env.DOCS_BASE ?? '/';
const prefix = base.replace(/\/$/, '');
const withBase = (url) =>
  prefix && url.startsWith('/') && !url.startsWith('//') && !url.startsWith(`${prefix}/`)
    ? `${prefix}${url}`
    : url;

function jsxLinks(node, ctx) {
  const attributes = node.attributes.map((attribute) =>
    attribute.name === 'href' && typeof attribute.value === 'string'
      ? { ...attribute, value: withBase(attribute.value) }
      : attribute,
  );
  if (attributes.some((attribute, index) => attribute !== node.attributes[index]))
    ctx.replaceNode(node, { ...node, attributes });
}

const baseLinks = defineMdastPlugin({
  name: 'nod-base-links',
  link(node, ctx) {
    const url = withBase(node.url);
    if (url !== node.url) ctx.replaceNode(node, { ...node, url });
  },
  mdxJsxFlowElement: jsxLinks,
  mdxJsxTextElement: jsxLinks,
});

const scrollTables = defineHastPlugin({
  name: 'nod-scroll-tables',
  element: {
    filter: ['table'],
    visit(node, ctx) {
      ctx.wrapNode(node, {
        type: 'element',
        tagName: 'div',
        properties: { className: ['nod-table'] },
        children: [],
      });
    },
  },
});

const section = (label, directory) => ({
  label,
  collapsed: true,
  items: [{ autogenerate: { directory } }],
});

export default defineConfig({
  site,
  base: prefix || '/',
  trailingSlash: 'always',
  devToolbar: { enabled: false },
  markdown: {
    processor: satteri({
      mdastPlugins: [baseLinks],
      hastPlugins: [scrollTables],
      features: { smartPunctuation: false },
    }),
  },
  vite: { server: { fs: { allow: ['.', '../public/fonts'] } } },
  integrations: [
    mermaid({
      theme: 'base',
      autoTheme: false,
      enableLog: false,
      mermaidConfig: {
        fontFamily: "'Geist', system-ui, sans-serif",
        themeVariables: { fontSize: '15px' },
        flowchart: { curve: 'basis', padding: 10, nodeSpacing: 28, rankSpacing: 32 },
        sequence: {
          mirrorActors: false,
          actorMargin: 32,
          messageMargin: 32,
          wrap: true,
          width: 130,
        },
      },
    }),
    starlight({
      title: 'nod',
      description:
        'nod is a personal assistant with its own computer. Learn how to install it, use it, and how it keeps your accounts and actions under your control.',
      logo: { light: './src/assets/nod-light.svg', dark: './src/assets/nod-dark.svg' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/n8n-io/nod' }],
      editLink: { baseUrl: 'https://github.com/n8n-io/nod/edit/main/docs/' },
      lastUpdated: true,
      customCss: ['./src/styles/theme.css'],
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: [
        section('Get started', 'get-started'),
        section('Use nod', 'use'),
        section('Trust and Vault', 'trust'),
        section('Connect', 'connect'),
        section('How nod works', 'how-it-works'),
        section('Deploy and operate', 'deploy'),
        section('Contribute', 'contribute'),
      ],
      plugins: [
        starlightLinksValidator(),
        starlightLlmsTxt({
          projectName: 'nod',
          description:
            'nod is a personal assistant you use through one chat. It has its own Linux workspace and browser, uses your connected apps, and keeps your accounts and actions under your control.',
        }),
      ],
    }),
  ],
});
