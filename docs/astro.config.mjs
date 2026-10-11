import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import { defineMdastPlugin } from 'satteri';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';

const site = process.env.DOCS_SITE || 'https://n8n-io.github.io';
const base = process.env.DOCS_BASE ?? '/otto';
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
  name: 'otto-base-links',
  link(node, ctx) {
    const url = withBase(node.url);
    if (url !== node.url) ctx.replaceNode(node, { ...node, url });
  },
  mdxJsxFlowElement: jsxLinks,
  mdxJsxTextElement: jsxLinks,
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
    processor: satteri({ mdastPlugins: [baseLinks], features: { smartPunctuation: false } }),
  },
  vite: { server: { fs: { allow: ['..'] } } },
  integrations: [
    mermaid({
      theme: 'base',
      autoTheme: false,
      enableLog: false,
      mermaidConfig: {
        fontFamily: "'n8n Baumer Uniwidth', system-ui, sans-serif",
        themeVariables: { fontSize: '15px' },
        flowchart: { curve: 'basis', padding: 14, nodeSpacing: 36, rankSpacing: 44 },
        sequence: { mirrorActors: false, actorMargin: 48, messageMargin: 36 },
      },
    }),
    starlight({
      title: 'Otto',
      description:
        'Otto is a personal assistant with its own computer. Learn how to install it, use it, and how it keeps your accounts and actions under your control.',
      logo: { light: './src/assets/otto-light.svg', dark: './src/assets/otto-dark.svg' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/n8n-io/otto' }],
      editLink: { baseUrl: 'https://github.com/n8n-io/otto/edit/main/docs/' },
      lastUpdated: true,
      customCss: ['./src/styles/otto.css'],
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: [
        section('Get started', 'get-started'),
        section('Use Otto', 'use'),
        section('Trust and Vault', 'trust'),
        section('Connect', 'connect'),
        section('How Otto works', 'how-it-works'),
        section('Deploy and operate', 'deploy'),
        section('Contribute', 'contribute'),
      ],
      plugins: [
        starlightLinksValidator(),
        starlightLlmsTxt({
          projectName: 'Otto',
          description:
            'Otto is a personal assistant you use through one chat. It has its own Linux workspace and browser, uses your connected apps, and keeps your accounts and actions under your control.',
        }),
      ],
    }),
  ],
});
