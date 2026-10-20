export const onboardingSteps = ['welcome', 'brain', 'email', 'about', 'telegram', 'open'] as const;
export const onboardingVersion = 2;
export type OnboardingStep = (typeof onboardingSteps)[number];
export const interviewQuestions = 3;
export const interviewAnswerChars = 1200;
export type InterviewMessage = { from: 'otto' | 'owner'; text: string };
export type InterviewResponse = { messages: string[]; done: boolean };
export type SuggestedTask = {
  id: string;
  title: string;
  source: 'gmail' | 'web' | 'telegram';
  kind?: 'now' | 'ongoing';
};
export type TaskSuggestions = { intro: string; tasks: SuggestedTask[] };
