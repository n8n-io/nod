import type { Command } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { canSplit, Transform } from '@tiptap/pm/transform';

export function formatSelectedText(
  typeName: 'paragraph' | 'heading',
  attrs: Record<string, unknown> = {},
): Command {
  return ({ tr, dispatch }) => {
    const type = tr.doc.type.schema.nodes[typeName];
    if (!type || tr.selection.empty) return false;

    const backward = tr.selection.anchor > tr.selection.head;
    const { from, to } = TextSelection.between(tr.selection.$from, tr.selection.$to);
    const transform = new Transform(tr.doc);
    const breaks = new Set<number>();
    transform.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === 'hardBreak') breaks.add(pos);
    });
    if (transform.doc.resolve(from).nodeBefore?.type.name === 'hardBreak') breaks.add(from - 1);
    if (transform.doc.resolve(to).nodeAfter?.type.name === 'hardBreak') breaks.add(to);

    for (const pos of [...breaks].sort((a, b) => b - a)) {
      transform.delete(pos, pos + 1);
      if (!canSplit(transform.doc, pos)) return false;
      transform.split(pos);
    }

    for (const [pos, association] of [
      [to, -1],
      [from, 1],
    ]) {
      const mapped = transform.mapping.map(pos, association);
      const resolved = transform.doc.resolve(mapped);
      if (
        resolved.parent.isTextblock &&
        resolved.parentOffset > 0 &&
        resolved.parentOffset < resolved.parent.content.size
      ) {
        if (!canSplit(transform.doc, mapped)) return false;
        transform.split(mapped);
      }
    }

    transform.setBlockType(
      transform.mapping.map(from, 1),
      transform.mapping.map(to, -1),
      type,
      attrs,
    );

    if (dispatch) {
      for (const step of transform.steps) tr.step(step);
      const start = transform.mapping.map(from, 1);
      const end = transform.mapping.map(to, -1);
      tr.setSelection(
        TextSelection.between(
          tr.doc.resolve(backward ? end : start),
          tr.doc.resolve(backward ? start : end),
        ),
      );
    }
    return true;
  };
}
