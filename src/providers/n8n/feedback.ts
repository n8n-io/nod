import type { FeedbackDelivery, FeedbackEnvelope } from '../../ports/feedback.ts';
import type { FeedbackReceipt } from '../../shared/feedback.ts';

export function createN8nFeedback(options: {
  url?: string;
  token?: string;
  request?: typeof fetch;
}): FeedbackDelivery {
  const request = options.request ?? fetch;
  const endpoint = options.url ? new URL(options.url) : undefined;
  if (
    endpoint &&
    (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash)
  )
    throw new Error('Feedback requires an HTTPS intake endpoint.');
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
          ...(options.token ? { 'x-otto-feedback-token': options.token } : {}),
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
        const url = new URL(receipt.issueUrl);
        if (
          url.origin !== 'https://linear.app' ||
          url.username ||
          url.password ||
          !/^\/n8n\/issue\/LAB-\d+(?:\/[^\s]*)?$/.test(url.pathname) ||
          url.search ||
          url.hash
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
    submit: send,
    status: (submissionId, payloadHash) => send({ action: 'status', submissionId, payloadHash }),
  };
}
