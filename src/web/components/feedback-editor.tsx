import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Extension } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { Plugin } from '@tiptap/pm/state';
import { feedbackLimits } from '../../shared/feedback';
import { createComposerExtensions } from '../lib/composer-editor';
import { composerMarkdown, parseComposerMarkdown } from '../lib/composer-markdown';
import { EditorFormatting } from './editor-formatting';

export interface FeedbackEditorHandle {
  focus(options?: FocusOptions): void;
}

interface FeedbackEditorProps {
  value: string;
  onChange(value: string): void;
  placeholder: string;
  disabled: boolean;
  onSubmit(): void;
  onUpload(files: File[]): void;
}

export const FeedbackEditor = forwardRef<FeedbackEditorHandle, FeedbackEditorProps>(
  function FeedbackEditor({ value, onChange, placeholder, disabled, onSubmit, onUpload }, ref) {
    const [limitReached, setLimitReached] = useState(false);
    const lastValue = useRef(value);
    const actions = useRef({ onChange, onSubmit, onUpload, placeholder, disabled });
    actions.current = { onChange, onSubmit, onUpload, placeholder, disabled };
    const extensions = useMemo(
      () => [
        ...createComposerExtensions({
          mode: 'feedback',
          placeholder: () => actions.current.placeholder,
          submit: () => {
            if (!actions.current.disabled) actions.current.onSubmit();
          },
          upload: (files) => {
            if (!actions.current.disabled) actions.current.onUpload(files);
          },
        }),
        Extension.create({
          name: 'feedbackLength',
          addProseMirrorPlugins() {
            const editor = this.editor;
            return [
              new Plugin({
                filterTransaction(transaction) {
                  if (!transaction.docChanged || transaction.getMeta('preventUpdate')) return true;
                  const length = composerMarkdown(transaction.doc).length;
                  const tooLong = length > feedbackLimits.text;
                  setLimitReached(tooLong);
                  return !tooLong || length < composerMarkdown(editor.state.doc).length;
                },
              }),
            ];
          },
        }),
      ],
      [],
    );
    const editor = useEditor({
      extensions,
      content: parseComposerMarkdown(value),
      immediatelyRender: false,
      editable: !disabled,
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-label': 'Your feedback',
          'aria-multiline': 'true',
          'aria-required': 'true',
          class: 'composer-editor feedback-editor message-text',
        },
        handleDOMEvents: {
          drop(_view, event) {
            if (!event.dataTransfer?.types.includes('Files')) return false;
            event.preventDefault();
            return true;
          },
        },
      },
      onUpdate: ({ editor: current }) => {
        const text = current.isEmpty ? '' : composerMarkdown(current.state.doc);
        lastValue.current = text;
        actions.current.onChange(text);
      },
    });
    useImperativeHandle(
      ref,
      () => ({
        focus(options) {
          if (editor && !editor.isDestroyed)
            editor.view.dom.focus(options ?? { preventScroll: true });
        },
      }),
      [editor],
    );
    useEffect(() => {
      if (!editor) return;
      if (value !== lastValue.current) {
        lastValue.current = value;
        editor.commands.setContent(parseComposerMarkdown(value), { emitUpdate: false });
      }
      if (editor.isEmpty && value) {
        lastValue.current = '';
        actions.current.onChange('');
      }
      setLimitReached(composerMarkdown(editor.state.doc).length > feedbackLimits.text);
    }, [editor, value]);
    useEffect(() => {
      if (!editor) return;
      editor.setEditable(!disabled, false);
      editor.view.dom.setAttribute('aria-disabled', String(disabled));
      editor.view.dispatch(editor.state.tr);
    }, [editor, disabled, placeholder]);
    return (
      <>
        <EditorContent editor={editor} />
        <EditorFormatting editor={editor} active={!disabled} />
        {limitReached && (
          <p className="feedback-length-error" role="alert">
            Feedback can contain up to 12,000 characters, including formatting. Shorten it before
            adding more.
          </p>
        )}
      </>
    );
  },
);
