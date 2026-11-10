import { Extension, InputRule, Mark, type Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { safeMessageLink } from './message-links';

export function clipboardFiles(clipboard: DataTransfer): File[] {
  const files = Array.from(clipboard.files ?? []);
  if (files.length) return files;
  return Array.from(clipboard.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function plainTextPasteSlice(editor: Editor, value: string) {
  const { schema } = editor;
  const raw = schema.marks.rawPaste.create();
  const content = value
    .split('\n')
    .flatMap((line, index) => [
      ...(index ? [schema.nodes.hardBreak.create(null, null, [raw])] : []),
      ...(line ? [schema.text(line, [raw])] : []),
    ]);
  return new Slice(Fragment.from(schema.nodes.paragraph.create(null, content)), 1, 1);
}

export function createComposerExtensions(callbacks: {
  submit(): void;
  upload(files: File[]): void;
  mode?: 'chat' | 'feedback';
  placeholder?: string | (() => string);
}) {
  return [
    StarterKit.configure({
      underline: false,
      link: {
        openOnClick: false,
        isAllowedUri: (url) => Boolean(safeMessageLink(url, window.location.origin)),
      },
    }),
    Mark.create({
      name: 'rawPaste',
      inclusive: false,
      excludes: 'link',
      parseHTML() {
        return [{ tag: 'span[data-raw-paste]' }];
      },
      renderHTML() {
        return ['span', { 'data-raw-paste': '' }, 0];
      },
    }),
    Underline,
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: callbacks.placeholder ?? 'Message Nod…' }),
    Extension.create({
      name: 'chatInput',
      priority: 1000,
      addInputRules() {
        return [
          new InputRule({
            find: /(?<=\n)[\t ]*(?:[-+*]|(\d+)\.)\s$/,
            handler: ({ state, range, match, chain }) => {
              const $start = state.doc.resolve(range.from);
              if (
                $start.parent.type.name !== 'paragraph' ||
                $start.nodeBefore?.type.name !== 'hardBreak'
              )
                return null;
              const marks = state.storedMarks || state.selection.$from.marks();
              return chain()
                .deleteRange({ from: range.from - 1, to: range.to })
                .setTextSelection(range.from - 1)
                .splitBlock()
                .wrapInList(
                  match[1] ? 'orderedList' : 'bulletList',
                  match[1] ? { start: Number(match[1]) } : undefined,
                )
                .command(({ tr }) => {
                  tr.ensureMarks(marks);
                  return true;
                })
                .run()
                ? undefined
                : null;
            },
          }),
        ];
      },
      addProseMirrorPlugins() {
        const editor = this.editor;
        return [
          new Plugin({
            props: {
              handleKeyDown(view, event) {
                if (
                  event.key !== 'Enter' ||
                  event.isComposing ||
                  view.composing ||
                  event.keyCode === 229
                )
                  return false;
                if (event.shiftKey || event.altKey) {
                  if (event.metaKey || event.ctrlKey) return false;
                  const { $from, empty } = view.state.selection;
                  const item = $from.depth > 0 ? $from.node(-1).type.name : undefined;
                  if (item === 'listItem' || item === 'taskItem')
                    return (
                      editor.commands.splitListItem(item) ||
                      (empty &&
                        $from.parent.content.size === 0 &&
                        editor.commands.liftListItem(item))
                    );
                  if ($from.parent.type.name === 'heading')
                    return editor.chain().splitBlock().setParagraph().run();
                  return editor.commands.setHardBreak();
                }
                if (callbacks.mode === 'feedback' && !event.metaKey && !event.ctrlKey) return false;
                event.preventDefault();
                callbacks.submit();
                return true;
              },
              handlePaste(view, event) {
                const clipboard = event.clipboardData;
                if (!clipboard) return false;
                const files = clipboardFiles(clipboard);
                const text = clipboard.getData('text/plain');
                if (!files.length && !text) return false;
                event.preventDefault();
                if (files.length) callbacks.upload(files);
                if (text) {
                  const value = text.replace(/\r\n?/g, '\n');
                  const { tr, selection } = view.state;
                  const code = Boolean(selection.$from.parent.type.spec.code);
                  if (code) tr.insertText(value);
                  else tr.replaceSelection(plainTextPasteSlice(editor, value));
                  tr.scrollIntoView().setMeta('paste', true);
                  if (code) tr.setMeta('uiEvent', 'paste');
                  view.dispatch(tr);
                }
                return true;
              },
            },
          }),
        ];
      },
    }),
  ];
}
