import type { FeedbackDelivery, FeedbackEnvelope } from '../../ports/feedback.ts';
import type { FeedbackReceipt } from '../../shared/feedback.ts';

function feedbackUrl(value: unknown) {
  try {
    if (
      typeof value !== 'string' ||
      !/^https:\/\//i.test(value) ||
      /[\\\u0000-\u0020\u007f?#]/.test(value) ||
      /%(?:2f|5c|2e|25)/i.test(value) ||
      /(?:^|\/)\.{1,2}(?:\/|$)/.test(value) ||
      /^https:\/\/[^/]*@/i.test(value)
    )
      throw new Error();
    const url = new URL(value);
    decodeURIComponent(url.pathname);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error();
    return url;
  } catch {
    throw new Error('Feedback URLs must use HTTPS without credentials, queries or fragments.');
  }
}

export function createN8nFeedback(options: {
  enabled?: boolean;
  url?: string;
  token?: string;
  receiptUrlPrefix?: string;
  recipient?: string;
  request?: typeof fetch;
}): FeedbackDelivery {
  const request = options.request ?? fetch;
  const endpoint = options.enabled !== false && options.url ? feedbackUrl(options.url) : undefined;
  const receiptPrefix =
    endpoint && options.receiptUrlPrefix ? feedbackUrl(options.receiptUrlPrefix) : undefined;
  if (receiptPrefix && (receiptPrefix.pathname === '/' || !receiptPrefix.pathname.endsWith('/')))
    throw new Error('The feedback receipt prefix must name an issue collection ending in /.');
  const receiptPath = receiptPrefix?.pathname;
  async function send(
    input: FeedbackEnvelope | { action: 'status'; submissionId: string; payloadHash: string },
  ): Promise<FeedbackReceipt> {
    const unknown: FeedbackReceipt = { submissionId: input.submissionId, status: 'unknown' };
    if (!endpoint) return { submissionId: input.submissionId, status: 'rejected' };
    try {
      const response = await request(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          ...(options.token ? { 'x-nod-feedback-token': options.token } : {}),
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(80_000),
      });
      if (response.status === 429 && !('action' in input))
        return {
          submissionId: input.submissionId,
          status: 'rejected',
          message: 'Please try again in a minute.',
        };
      if ((!response.ok && response.status !== 400) || !response.body) return unknown;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > 8192) {
          await reader.cancel();
          return unknown;
        }
        chunks.push(result.value);
      }
      const receipt = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (
        receipt.submissionId !== input.submissionId ||
        (!response.ok && receipt.status !== 'rejected') ||
        !['submitted', 'partial', 'unknown', 'rejected'].includes(receipt.status)
      )
        return unknown;
      let issueUrl: string | undefined;
      if (receipt.issueUrl !== undefined) {
        const url = feedbackUrl(receipt.issueUrl);
        if (
          receiptPrefix
            ? url.origin !== receiptPrefix.origin ||
              !url.pathname.startsWith(receiptPath!) ||
              url.pathname.length <= receiptPath!.length
            : url.origin !== 'https://linear.app' ||
              !/^\/n8n\/issue\/LAB-\d+(?:\/[^\s]*)?$/.test(url.pathname)
        )
          return unknown;
        issueUrl = url.href;
      }
      if (['submitted', 'partial'].includes(receipt.status) && !issueUrl) return unknown;
      const message =
        typeof receipt.message === 'string' && receipt.message.length <= 1000
          ? receipt.message.trim()
          : undefined;
      return {
        submissionId: input.submissionId,
        status: receipt.status,
        ...(issueUrl && { issueUrl }),
        ...(message && { message }),
      };
    } catch {
      return unknown;
    }
  }
  return {
    configured: !!endpoint,
    recipient: endpoint ? (options.recipient ?? endpoint.host) : null,
    submit: send,
    status: (submissionId, payloadHash) => send({ action: 'status', submissionId, payloadHash }),
  };
}
