import Underline from '@tiptap/extension-underline';

export const ComposerUnderline = Underline.extend({
  renderMarkdown(node, helpers) {
    return `<u>${helpers.renderChildren(node)}</u>`;
  },
  markdownTokenizer: {
    name: 'underline',
    level: 'inline',
    start(source) {
      const html = source.indexOf('<u>');
      const legacy = source.indexOf('++');
      return html < 0 ? legacy : legacy < 0 ? html : Math.min(html, legacy);
    },
    tokenize(source, _tokens, lexer) {
      const match = /^(?:<u>([\s\S]+?)<\/u>|\+\+([\s\S]+?)\+\+)/.exec(source);
      if (!match) return undefined;
      const text = match[1] ?? match[2];
      return {
        type: 'underline',
        raw: match[0],
        text,
        tokens: lexer.inlineTokens(text),
      };
    },
  },
});
