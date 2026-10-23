import { createFeedbackActivity } from '../../shared/feedback-activity';

export const feedbackActivity = createFeedbackActivity('app');
export const feedbackActivitySnapshot = () => feedbackActivity.snapshot();
