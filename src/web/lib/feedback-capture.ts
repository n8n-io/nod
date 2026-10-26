import { feedbackLimits } from '../../shared/feedback';
import { desktopFeedbackScreenshot } from './desktop';

export async function captureFeedbackScreenshot(): Promise<File | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const capture = desktopFeedbackScreenshot();
    if (!capture) return null;
    const bytes = await Promise.race([
      capture,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1_200);
      }),
    ]);
    if (!bytes?.length || bytes.length > feedbackLimits.attachmentBytes) return null;
    return new File([new Uint8Array(bytes)], 'nod-screenshot.jpg', { type: 'image/jpeg' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
