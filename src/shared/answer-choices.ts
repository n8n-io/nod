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
  z.object({ choiceIds: z.array(z.uuid()).min(1).max(6) }).strict(),
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

export function questionWithChoices(question: string, choices: AnswerChoices) {
  return [
    question,
    choices.options
      .map((option, index) => `${index + 1}. ${choiceAnswerText([option])}`)
      .join('\n'),
  ].join('\n\n');
}
