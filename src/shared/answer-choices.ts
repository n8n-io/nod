import { z } from 'zod';

export const answerChoiceInputSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(400).optional(),
  })
  .strict();

export const answerChoicesSchema = z
  .object({
    options: z
      .array(answerChoiceInputSchema.extend({ id: z.uuid() }))
      .min(1)
      .max(6),
    multiple: z.boolean(),
  })
  .strict()
  .refine(
    (value) => new Set(value.options.map((option) => option.id)).size === value.options.length,
  );

export const questionAnswerSchema = z.union([
  z
    .object({ choiceIds: z.array(z.uuid()).min(1).max(6), custom: z.literal(true).optional() })
    .strict(),
  z.object({ custom: z.literal(true) }).strict(),
]);

export type AnswerChoice = z.infer<typeof answerChoicesSchema>['options'][number];
export type AnswerChoices = z.infer<typeof answerChoicesSchema>;
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

export function choiceAnswerText(options: AnswerChoice[]) {
  return options
    .map(({ label, description }) => {
      const detail = description?.trim();
      return detail && detail.toLowerCase() !== label.trim().toLowerCase()
        ? `${label.trim()}: ${detail}`
        : label.trim();
    })
    .join('\n');
}

export function writtenAnswer(options: AnswerChoice[], text: string) {
  const chosen = `${choiceAnswerText(options)}\n`;
  return text.startsWith(chosen) ? text.slice(chosen.length).trim() : '';
}

export function questionWithChoices(question: string, choices: AnswerChoices) {
  return [
    question,
    choices.options
      .map((option, index) => `${index + 1}. ${choiceAnswerText([option])}`)
      .join('\n'),
  ].join('\n\n');
}

export function splitQuestion(text: string) {
  const whole = text.trim();
  const question = whole
    .split(/\n[ \t]*\n/)
    .at(-1)!
    .trim();
  const lead = whole.slice(0, whole.length - question.length).trimEnd();
  return lead &&
    !question.includes('\n') &&
    /[?？؟][*_"'”’)\]]*$/.test(question) &&
    !/^(```|~~~|[-*+] |\d+[.)] |[|>#])/.test(question) &&
    (lead.match(/^[ \t]*(```|~~~)/gm)?.length ?? 0) % 2 === 0
    ? { lead, question }
    : { lead: '', question: whole };
}
