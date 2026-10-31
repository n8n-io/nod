import { z } from 'zod';

export const churnReasons = [
  'no_useful_task',
  'setup',
  'unreliable',
  'slow',
  'cost',
  'privacy',
  'another_tool',
  'other',
] as const;

export const churnLabels: Record<(typeof churnReasons)[number], string> = {
  no_useful_task: 'I did not find a useful task',
  setup: 'Setup or connections were difficult',
  unreliable: 'Results were unreliable',
  slow: 'It took too long',
  cost: 'It cost too much',
  privacy: 'I had privacy or trust concerns',
  another_tool: 'I use another tool',
  other: 'Other',
};

export const productSurveys = {
  nps: {
    id: '01a19201-fd0d-0000-ba43-1697b4bb6e32',
    questionId: 'a94910e5-89b4-485b-881d-1b8f9da76a41',
    question: 'How likely are you to recommend Nod to a friend or colleague?',
  },
  churn: {
    id: '01a19202-0087-0000-11c5-742616c67c8c',
    questionId: '2f505eca-d3b3-4460-8a02-ab92897ba859',
    question: 'What is the main reason you stopped using Nod?',
  },
} as const;

export type ProductSurvey = keyof typeof productSurveys;
export type ProductSurveyOffer = { survey: ProductSurvey; submission_id: string };

const offer = z.object({
  survey: z.enum(['nps', 'churn']),
  submission_id: z.uuid(),
});

export const productSurveyEventSchema = z.union([
  offer.extend({ status: z.enum(['shown', 'dismissed']) }).strict(),
  offer
    .extend({
      status: z.literal('sent'),
      survey: z.literal('nps'),
      score: z.number().int().min(0).max(10),
    })
    .strict(),
  offer
    .extend({ status: z.literal('sent'), survey: z.literal('churn'), reason: z.enum(churnReasons) })
    .strict(),
]);

export type ProductSurveyEvent = z.infer<typeof productSurveyEventSchema>;
