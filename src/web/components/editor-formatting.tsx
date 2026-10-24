import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import {
  Bold,
  Check,
  ChevronDown,
  Italic,
  Link2,
  List,
  ListOrdered,
  Underline,
  Unlink,
  X,
} from './icons';
import { formatSelectedText } from '../lib/editor-formatting';
import { safeMessageLink } from '../lib/message-links';

const styles = [
  ['paragraph', 'Text', 'T'],
  ['heading1', 'Heading 1', 'H₁'],
  ['heading2', 'Heading 2', 'H₂'],
  ['heading3', 'Heading 3', 'H₃'],
  ['orderedList', 'Numbered list', ListOrdered],
  ['bulletList', 'Bulleted list', List],
] as const;

function activeBlock(editor: Editor) {
  if (editor.isActive('bulletList')) return 'bulletList';
  if (editor.isActive('orderedList')) return 'orderedList';
  for (const level of [1, 2, 3])
    if (editor.isActive('heading', { level })) return `heading${level}`;
  return editor.isActive('paragraph') && !editor.isActive('taskList') ? 'paragraph' : 'other';
}

function linkHref(value: string) {
  const text = value.trim();
  if (!text) return null;
  return (
    safeMessageLink(
      text.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`,
      window.location.origin,
    )?.href ?? null
  );
}

export function EditorFormatting({
  editor,
  active = true,
}: {
  editor: Editor | null;
  active?: boolean;
}) {
  return editor ? <FormattingMenu editor={editor} active={active} /> : null;
}

function FormattingMenu({ editor, active }: { editor: Editor; active: boolean }) {
  const id = useId();
  const pluginKey = `formatting-${id}`;
  const [panel, setPanel] = useState<'styles' | 'link' | null>(null);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [url, setUrl] = useState('');
  const [linkError, setLinkError] = useState(false);
  const dismissed = useRef(false);
  const toolbar = useRef<HTMLDivElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const actions = useRef({
    keyDown: (_event: KeyboardEvent): boolean => false,
    escape: () => {},
  });
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      block: activeBlock(current),
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      underline: current.isActive('underline'),
      link: current.isActive('link'),
    }),
  });
  const options = useMemo(
    () => ({
      placement: 'top' as const,
      strategy: 'fixed' as const,
      offset: 9,
      flip: { padding: 12 },
      shift: { padding: 12 },
      scrollTarget: editor.view.dom,
      onHide: () => setPanel(null),
    }),
    [editor],
  );
  const appendTo = useCallback(
    () => editor.view.dom.closest<HTMLElement>('[role="dialog"]') ?? document.body,
    [editor],
  );
  const shouldShow = useCallback(
    ({ element }: { element: HTMLElement }) => {
      const { doc, selection } = editor.state;
      return (
        active &&
        editor.isEditable &&
        !dismissed.current &&
        !selection.empty &&
        !!doc.textBetween(selection.from, selection.to).trim() &&
        (editor.isFocused || element.contains(document.activeElement))
      );
    },
    [active, editor],
  );

  function reveal() {
    editor.view.dispatch(editor.state.tr.setMeta(pluginKey, 'show'));
    editor.view.dispatch(editor.state.tr.setMeta(pluginKey, 'updatePosition'));
  }
  function menuVisible() {
    return toolbar.current?.isConnected && toolbar.current.style.visibility === 'visible';
  }
  function closePanel() {
    setPanel(null);
    editor.commands.focus(undefined, { scrollIntoView: false });
  }
  function dismiss() {
    dismissed.current = true;
    setPanel(null);
    editor.view.focus();
    editor.view.dispatch(editor.state.tr.setMeta(pluginKey, 'hide'));
  }
  function openLink() {
    setUrl(editor.getAttributes('link').href ?? '');
    setLinkError(false);
    dismissed.current = false;
    reveal();
    setPanel('link');
  }
  function applyLink() {
    const href = linkHref(url);
    if (!href) return setLinkError(true);
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    closePanel();
  }
  function applyStyle(value: (typeof styles)[number][0]) {
    if (state.block !== value) {
      let chain = editor.chain().focus();
      if (value === 'bulletList') chain.toggleBulletList().run();
      else if (value === 'orderedList') chain.toggleOrderedList().run();
      else {
        if (editor.isActive('bulletList')) chain = chain.toggleBulletList();
        else if (editor.isActive('orderedList')) chain = chain.toggleOrderedList();
        else if (editor.isActive('taskList')) chain = chain.toggleTaskList();
        chain
          .command(
            value === 'paragraph'
              ? formatSelectedText('paragraph')
              : formatSelectedText('heading', { level: Number(value.at(-1)) }),
          )
          .run();
      }
    }
    closePanel();
  }
  actions.current.keyDown = (event) => {
    if (
      !active ||
      !editor.isEditable ||
      event.isComposing ||
      editor.view.composing ||
      event.keyCode === 229
    )
      return false;
    const { doc, selection } = editor.state;
    if (selection.empty || !doc.textBetween(selection.from, selection.to).trim()) return false;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openLink();
      return true;
    }
    if (event.key === 'Tab' && !event.shiftKey && !dismissed.current) {
      event.preventDefault();
      reveal();
      toolbar.current?.querySelector('button')?.focus();
      return true;
    }
    if (event.key === 'Escape' && menuVisible()) {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return true;
    }
    return false;
  };
  actions.current.escape = () => {
    panel ? closePanel() : dismiss();
  };

  useEffect(() => {
    const key = new PluginKey(`${pluginKey}-keys`);
    editor.registerPlugin(
      new Plugin({
        key,
        props: {
          handleKeyDown: (_view, event) => actions.current.keyDown(event),
        },
      }),
      (plugin, plugins) => [plugin, ...plugins],
    );
    const select = () => {
      dismissed.current = false;
    };
    const reposition = (event: Event) => {
      if (event.target !== editor.view.dom && menuVisible())
        editor.view.dispatch(editor.state.tr.setMeta(pluginKey, 'updatePosition'));
    };
    const outside = (event: Event) => {
      if (
        menuVisible() &&
        event.target instanceof Node &&
        !editor.view.dom.contains(event.target) &&
        !toolbar.current?.contains(event.target)
      )
        editor.view.dispatch(editor.state.tr.setMeta(pluginKey, 'hide'));
    };
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        menuVisible() &&
        event.target instanceof Node &&
        (editor.view.dom.contains(event.target) || toolbar.current?.contains(event.target))
      ) {
        event.preventDefault();
        event.stopPropagation();
        actions.current.escape();
      }
    };
    editor.on('selectionUpdate', select);
    window.addEventListener('keydown', escape, true);
    document.addEventListener('scroll', reposition, true);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    return () => {
      editor.off('selectionUpdate', select);
      window.removeEventListener('keydown', escape, true);
      document.removeEventListener('scroll', reposition, true);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
      if (!editor.isDestroyed) editor.unregisterPlugin(key);
    };
  }, [editor, pluginKey]);
  useEffect(() => {
    if (!active) editor.view.dispatch(editor.state.tr.setMeta(pluginKey, 'hide'));
  }, [active, editor, pluginKey]);
  useEffect(() => {
    if (panel === 'link') urlInput.current?.focus();
    if (panel === 'styles')
      (
        toolbar.current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
        toolbar.current?.querySelector<HTMLElement>('[role="menuitemradio"]')
      )?.focus();
    const frame = requestAnimationFrame(() => {
      if (!editor.isDestroyed)
        editor.view.dispatch(editor.state.tr.setMeta(pluginKey, 'updatePosition'));
    });
    return () => cancelAnimationFrame(frame);
  }, [panel, editor, pluginKey]);

  function menuKeyDown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (
      !(event.target instanceof HTMLInputElement) &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey
    ) {
      const command = { b: 'toggleBold', i: 'toggleItalic', u: 'toggleUnderline' }[
        event.key.toLowerCase()
      ] as 'toggleBold' | 'toggleItalic' | 'toggleUnderline' | undefined;
      if (command) {
        event.preventDefault();
        event.stopPropagation();
        editor.chain().focus()[command]().run();
        return;
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      panel ? closePanel() : dismiss();
    } else if (panel === 'link' && event.key === 'Enter' && event.target === urlInput.current) {
      event.preventDefault();
      event.stopPropagation();
      applyLink();
    } else if (event.key === 'Tab') {
      if (panel === 'styles') setKeyboardFocus(true);
      const controls = [
        ...(toolbar.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') ?? []),
      ];
      if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) {
        event.preventDefault();
        closePanel();
      }
    } else if (panel === 'styles' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      setKeyboardFocus(true);
      const items = [
        ...(toolbar.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []),
      ];
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  return (
    <BubbleMenu
      editor={editor}
      pluginKey={pluginKey}
      ref={toolbar}
      appendTo={appendTo}
      shouldShow={shouldShow}
      updateDelay={300}
      options={options}
      className="editor-formatting"
      onKeyDown={(event) => menuKeyDown(event.nativeEvent ?? event)}
    >
      {panel === 'styles' && (
        <div
          role="menu"
          aria-label="Text style"
          className="editor-style-menu"
          data-keyboard-focus={keyboardFocus}
          onPointerMove={() => setKeyboardFocus(false)}
        >
          {styles.map(([value, label, Icon]) => (
            <button
              type="button"
              key={value}
              role="menuitemradio"
              aria-checked={state.block === value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applyStyle(value)}
            >
              <span className="editor-style-icon">
                {typeof Icon === 'string' ? Icon : <Icon size={17} />}
              </span>
              <span>{label}</span>
              {state.block === value && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
      {panel === 'link' ? (
        <div className="editor-link-panel">
          <Link2 size={16} />
          <input
            ref={urlInput}
            type="text"
            aria-label="Link URL"
            placeholder="Type or paste a link"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setLinkError(false);
            }}
            aria-invalid={linkError}
            aria-describedby={linkError ? `${id}-link-error` : undefined}
          />
          {state.link && (
            <button
              type="button"
              className="editor-format-tool"
              aria-label="Remove link"
              onClick={() => {
                editor.chain().focus().extendMarkRange('link').unsetLink().run();
                closePanel();
              }}
            >
              <Unlink size={16} />
            </button>
          )}
          <button
            type="button"
            className="editor-apply-link"
            aria-label="Apply link"
            disabled={!url.trim()}
            onClick={applyLink}
          >
            <Check size={16} />
          </button>
          <button
            type="button"
            className="editor-format-tool"
            aria-label="Cancel link"
            onClick={closePanel}
          >
            <X size={15} />
          </button>
          {linkError && (
            <div id={`${id}-link-error`} className="editor-link-error" role="alert">
              Enter a valid website link.
            </div>
          )}
        </div>
      ) : (
        <div className="editor-format-bar" role="toolbar" aria-label="Text formatting">
          <button
            type="button"
            className="editor-format-tool"
            aria-label="Link"
            aria-pressed={state.link}
            title={`Link (${modifier}K)`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={openLink}
          >
            <Link2 size={17} />
          </button>
          {(
            [
              ['bold', 'Bold', 'B', Bold, 'toggleBold'],
              ['italic', 'Italic', 'I', Italic, 'toggleItalic'],
              ['underline', 'Underline', 'U', Underline, 'toggleUnderline'],
            ] as const
          ).map(([mark, label, key, Icon, command]) => (
            <button
              type="button"
              key={mark}
              className="editor-format-tool"
              aria-label={label}
              aria-pressed={state[mark]}
              title={`${label} (${modifier}${key})`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => editor.chain().focus()[command]().run()}
            >
              <Icon size={17} />
            </button>
          ))}
          <span className="editor-format-separator" />
          <button
            type="button"
            className="editor-style-trigger"
            aria-label="Text style"
            aria-haspopup="menu"
            aria-expanded={panel === 'styles'}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              setKeyboardFocus(event.detail === 0);
              setPanel(panel === 'styles' ? null : 'styles');
            }}
          >
            {styles.find(([value]) => value === state.block)?.[1] ?? 'Text'}
            <ChevronDown size={13} />
          </button>
        </div>
      )}
    </BubbleMenu>
  );
}
