import { feedbackLimits } from '../../shared/feedback';
import { desktopFeedbackScreenshot, desktopFeedbackScreenshotAvailable } from './desktop';
import { hasFeedbackDraft, loadFeedbackDraft, readFeedbackPending } from './feedback-draft';

export function createFeedbackCapture(ownerId: string) {
  let pending: Promise<File | null> | undefined;
  return {
    capture() {
      return (pending ??=
        desktopFeedbackScreenshotAvailable() &&
        !readFeedbackPending(`nod.feedback.pending.${ownerId}`)
          ? loadFeedbackDraft(ownerId)
              .then((draft) =>
                draft && hasFeedbackDraft(draft) ? null : captureFeedbackScreenshot(),
              )
              .catch(() => null)
          : Promise.resolve(null));
    },
    reset() {
      pending = undefined;
    },
  };
}

async function captureFeedbackScreenshot(): Promise<File | null> {
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
