import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Check,
  ChevronDown,
  Copy,
  FileJson,
  Lightbulb,
  MessageCircle,
  Paperclip,
  Send,
  X,
} from 'lucide-react';
import {
  feedbackLimits,
  type FeedbackAttachment,
  type FeedbackContext,
  type FeedbackReceipt,
  type FeedbackReport,
  type FeedbackSubmission,
} from '../../shared/feedback';
import { api, ApiError, errorMessage } from '../lib/api';
import { desktopFeedbackContext } from '../lib/desktop';
import { Button, Dialog, DialogContent, DialogTitle } from './ui';

const categories = [
  { id: 'bug', title: 'Something isn’t working', short: 'Bug or issue', icon: Bug },
  { id: 'feature', title: 'I have an idea', short: 'Feature request', icon: Lightbulb },
  { id: 'other', title: 'Something else', short: 'Other feedback', icon: MessageCircle },
] as const;

function readPending(key: string) {
  try {
    const id = window.localStorage.getItem(key);
    return id && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      ? id
      : null;
  } catch {
    return null;
  }
}

function writePending(key: string, id: string | null) {
  try {
    if (id) window.localStorage.setItem(key, id);
    else window.localStorage.removeItem(key);
  } catch {}
}

async function encodeAttachment(file: File): Promise<FeedbackAttachment> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error(`Couldn’t read ${file.name}. Add it again.`));
    reader.readAsDataURL(file);
  });
  return { name: file.name, mimeType: file.type as FeedbackAttachment['mimeType'], data };
}

export function FeedbackDialog({
  ownerId,
  open,
  onOpenChange,
  returnFocus,
}: {
  ownerId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  returnFocus(): HTMLElement | null;
}) {
  const storageKey = `otto.feedback.pending.${ownerId}`;
  const [pendingId, setPendingId] = useState(() => readPending(storageKey));
  const [step, setStep] = useState(() => (pendingId ? 2 : 0));
  const [kind, setKind] = useState<FeedbackSubmission['category']>('bug');
  const [feedback, setFeedback] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [includeReport, setIncludeReport] = useState(true);
  const [report, setReport] = useState<FeedbackReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState('');
  const [preview, setPreview] = useState(false);
  const [context, setContext] = useState<FeedbackContext | null>(null);
  const [contextError, setContextError] = useState('');
  const [development, setDevelopment] = useState(import.meta.env?.DEV === true);
  const [receipt, setReceipt] = useState<FeedbackReceipt | null>(() =>
    pendingId ? { submissionId: pendingId, status: 'unknown' } : null,
  );
  const [busy, setBusy] = useState<'sending' | 'checking' | 'repairing' | null>(null);
  const [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied'>('idle');
  const [toast, setToast] = useState(false);
  const [contextAttempt, setContextAttempt] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const detailsInput = useRef<HTMLTextAreaElement>(null);
  const submission = useRef<FeedbackSubmission | null>(null);
  const reportRequest = useRef<{
    controller: AbortController;
    promise: Promise<FeedbackReport | null>;
  } | null>(null);
  const sendRequest = useRef<AbortController | null>(null);
  const copyRequest = useRef<AbortController | null>(null);
  const reportRef = useRef<FeedbackReport | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const hasReport = kind === 'bug' && includeReport;
  const frozen = !!busy || !!pendingId;
  const category = categories.find((item) => item.id === kind)!;
  const valid = !!feedback.trim();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const native = Promise.resolve(desktopFeedbackContext());
    setContextError('');
    setContext(null);
    void Promise.allSettled([
      api<FeedbackContext>('/api/feedback/context', {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      }),
      native,
    ]).then(([server, native]) => {
      if (controller.signal.aborted) return;
      const device = native.status === 'fulfilled' ? native.value : undefined;
      const dev =
        device?.development ??
        (import.meta.env?.DEV === true ||
          (server.status === 'fulfilled' && server.value.development));
      setDevelopment(dev);
      if (server.status === 'rejected' || native.status === 'rejected') {
        setContextError('Couldn’t load feedback.');
        return;
      }
      setContext({
        ...server.value,
        ...device,
        appRelease: device?.appRelease ?? server.value.appRelease,
        appModified: device?.appModified ?? server.value.appModified,
        platform: device?.platform ?? server.value.platform ?? (navigator.platform || null),
        development: dev,
      });
    });
    return () => controller.abort();
  }, [open, contextAttempt]);

  useEffect(() => {
    if (open) return;
    reportRequest.current?.controller.abort();
    reportRequest.current = null;
    copyRequest.current?.abort();
    copyRequest.current = null;
    setReportLoading(false);
    setCopyStatus('idle');
  }, [open]);

  useEffect(() => {
    if (!open || pendingId) return;
    const saved = readPending(storageKey);
    if (!saved) return;
    setPendingId(saved);
    setReceipt({ submissionId: saved, status: 'unknown' });
    setStep(2);
  }, [open, pendingId, storageKey]);

  useEffect(() => {
    if (!open) return;
    if (step === 1) detailsInput.current?.focus();
    else if (step === 2) reviewHeading.current?.focus();
  }, [open, step]);

  useEffect(() => {
    if (open && step === 2 && hasReport && !pendingId && !reportRef.current) void prepareReport();
  }, [open, step, hasReport, pendingId]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(false), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (copyStatus !== 'copied') return;
    const timer = setTimeout(() => setCopyStatus('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  useEffect(
    () => () => {
      reportRequest.current?.controller.abort();
      sendRequest.current?.abort();
      copyRequest.current?.abort();
    },
    [],
  );

  async function prepareReport() {
    if (reportRef.current && Date.parse(reportRef.current.expiresAt) > Date.now())
      return reportRef.current;
    if (reportRequest.current) return reportRequest.current.promise;
    const controller = new AbortController();
    setReportLoading(true);
    setReportError('');
    setReport(null);
    reportRef.current = null;
    setPreview(false);
    const promise = api<FeedbackReport>('/api/feedback/report', {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    })
      .then((snapshot) => {
        if (controller.signal.aborted) return null;
        reportRef.current = snapshot;
        setReport(snapshot);
        return snapshot;
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setReportError(errorMessage(cause));
        return null;
      })
      .finally(() => {
        if (reportRequest.current?.controller === controller) reportRequest.current = null;
        if (!controller.signal.aborted) setReportLoading(false);
      });
    reportRequest.current = { controller, promise };
    return promise;
  }

  function complete() {
    writePending(storageKey, null);
    setPendingId(null);
    submission.current = null;
    setReceipt(null);
    setBusy(null);
    setStep(0);
    setKind('bug');
    setFeedback('');
    setAttachments([]);
    setIncludeReport(true);
    setReport(null);
    reportRef.current = null;
    setReportError('');
    setPreview(false);
    setError('');
    setToast(true);
    onOpenChange(false);
  }

  function applyReceipt(result: FeedbackReceipt) {
    if (result.status === 'submitted') {
      complete();
      return;
    }
    setReceipt(result);
    if (result.status === 'rejected') {
      writePending(storageKey, null);
      setPendingId(null);
      submission.current = null;
      setError(result.message || 'Couldn’t send your feedback. Your draft is still here.');
      if (!feedback.trim()) setStep(0);
    } else {
      writePending(storageKey, result.submissionId);
      setPendingId(result.submissionId);
    }
  }

  async function send() {
    if (!valid || frozen || sendRequest.current || !context?.enabled) return;
    const existing = readPending(storageKey);
    if (existing) {
      setPendingId(existing);
      setReceipt({ submissionId: existing, status: 'unknown' });
      return;
    }
    if (hasReport && (!report || Date.parse(report.expiresAt) <= Date.now())) {
      setReportError('Refresh the diagnostic report before sending.');
      setReport(null);
      reportRef.current = null;
      return;
    }
    const controller = new AbortController();
    sendRequest.current = controller;
    setBusy('sending');
    setError('');
    setReceipt(null);
    let id: string | null = null;
    try {
      const encoded = await Promise.all(attachments.map(encodeAttachment));
      if (controller.signal.aborted) return;
      const payload: FeedbackSubmission = {
        submissionId: crypto.randomUUID(),
        category: kind,
        feedback: feedback.trim(),
        computerName: context.computerName,
        appVersion: context.appVersion,
        appRelease: context.appRelease,
        appModified: context.appModified,
        platform: context.platform,
        development: context.development,
        source: context.source,
        reportId: hasReport ? report!.id : null,
        attachments: encoded,
      };
      submission.current = payload;
      id = payload.submissionId;
      writePending(storageKey, id);
      setPendingId(id);
      const result = await api<FeedbackReceipt>('/api/feedback', {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
      });
      if (!controller.signal.aborted) applyReceipt(result);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const rejected =
        cause instanceof ApiError &&
        ((cause.status >= 400 && cause.status < 500 && ![408, 409].includes(cause.status)) ||
          cause.status === 503);
      if (id && !rejected) applyReceipt({ submissionId: id, status: 'unknown' });
      else {
        writePending(storageKey, null);
        setPendingId(null);
        submission.current = null;
        setError(errorMessage(cause));
        if (cause instanceof ApiError && cause.status === 410) {
          setReport(null);
          reportRef.current = null;
          setReportError('Refresh the diagnostic report before sending.');
        }
      }
    } finally {
      if (sendRequest.current === controller) sendRequest.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  async function checkStatus() {
    if (!pendingId || busy || sendRequest.current) return;
    const controller = new AbortController();
    sendRequest.current = controller;
    setBusy('checking');
    setError('');
    try {
      const result = await api<FeedbackReceipt>(`/api/feedback/${pendingId}`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
      });
      if (!controller.signal.aborted) applyReceipt(result);
    } catch {
      if (!controller.signal.aborted)
        setError('Couldn’t check the result. Try again when you’re connected.');
    } finally {
      if (sendRequest.current === controller) sendRequest.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  async function retryAttachments() {
    if (!pendingId || busy || sendRequest.current || !receipt?.canRetryAttachments) return;
    const controller = new AbortController();
    sendRequest.current = controller;
    setBusy('repairing');
    setError('');
    try {
      const result = await api<FeedbackReceipt>(`/api/feedback/${pendingId}/retry`, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
      });
      if (!controller.signal.aborted) applyReceipt(result);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 410) {
        setReceipt({ ...receipt, canRetryAttachments: false });
        setError('The attachments are no longer available. You can finish without them.');
      } else {
        applyReceipt({ submissionId: pendingId, status: 'unknown' });
      }
    } finally {
      if (sendRequest.current === controller) sendRequest.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  async function copyReport() {
    if (frozen || copyRequest.current) return;
    const controller = new AbortController();
    copyRequest.current = controller;
    setCopyStatus('copying');
    setError('');
    try {
      const snapshot = await prepareReport();
      if (controller.signal.aborted) return;
      if (!snapshot) {
        setCopyStatus('idle');
        setError('Couldn’t prepare the trace. Try again.');
        return;
      }
      await navigator.clipboard.writeText(snapshot.content);
      if (!controller.signal.aborted) setCopyStatus('copied');
    } catch (cause) {
      if (!controller.signal.aborted) {
        setCopyStatus('idle');
        setError(errorMessage(cause));
      }
    } finally {
      if (copyRequest.current === controller) copyRequest.current = null;
    }
  }

  function addAttachments(files: File[]) {
    const next = [...attachments, ...files];
    if (next.length > feedbackLimits.attachments) {
      setError('You can attach up to 3 screenshots.');
      return;
    }
    if (files.some((file) => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) {
      setError('Choose PNG, JPEG or WebP screenshots.');
      return;
    }
    if (files.some((file) => file.size > feedbackLimits.attachmentBytes)) {
      setError('Each screenshot must be 2 MB or smaller.');
      return;
    }
    if (next.reduce((total, file) => total + file.size, 0) > feedbackLimits.totalAttachmentBytes) {
      setError('Keep the screenshots under 4 MB in total.');
      return;
    }
    setError('');
    setAttachments(next);
  }

  function next(event: FormEvent) {
    event.preventDefault();
    if (frozen) return;
    setError('');
    if (step === 2) void send();
    else if (step === 1) {
      if (!valid) return;
      setStep(2);
    } else setStep(1);
  }

  const copyButton = (
    <Button
      type="button"
      variant="ghost"
      disabled={frozen || copyStatus === 'copying'}
      onClick={() => void copyReport()}
    >
      <Copy size={15} aria-hidden="true" />
      {copyStatus === 'copying' ? 'Copying…' : copyStatus === 'copied' ? 'Copied' : 'Copy trace'}
    </Button>
  );

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) onOpenChange(value);
        }}
      >
        <DialogContent
          className="feedback-dialog"
          aria-describedby={undefined}
          data-busy={!!busy}
          onCloseAutoFocus={(event) => {
            const target = returnFocus();
            if (target?.isConnected) {
              event.preventDefault();
              target.focus({ preventScroll: true });
            }
          }}
        >
          <header className="feedback-header">
            <DialogTitle ref={reviewHeading} tabIndex={-1}>
              {step === 2 ? 'Review feedback' : step === 1 ? 'Your feedback' : 'Send feedback'}
            </DialogTitle>
          </header>
          <div className="feedback-progress" aria-label="Progress">
            {['Type', 'Feedback', 'Review'].map((label, index) => (
              <div
                key={label}
                className={index === step ? 'current' : index < step ? 'done' : ''}
                aria-current={index === step ? 'step' : undefined}
              >
                <span>{index < step ? <Check size={12} aria-hidden="true" /> : index + 1}</span>
                {label}
              </div>
            ))}
          </div>
          <form className="feedback-form" onSubmit={next}>
            <div className="feedback-body">
              {step === 0 ? (
                <div className="feedback-category-options" role="group" aria-label="Feedback type">
                  {categories.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={`feedback-category-option ${kind === item.id ? 'selected' : ''}`}
                      aria-pressed={kind === item.id}
                      onClick={() => {
                        setKind(item.id);
                        setIncludeReport(item.id === 'bug');
                        setPreview(false);
                      }}
                    >
                      <item.icon size={21} aria-hidden="true" />
                      <div>
                        <strong>{item.title}</strong>
                      </div>
                      <span className="feedback-category-radio" aria-hidden="true">
                        {kind === item.id && <span />}
                      </span>
                    </button>
                  ))}
                </div>
              ) : step === 1 ? (
                <div className="feedback-details-form">
                  <label className="field">
                    <span className="sr-only">Your feedback</span>
                    <textarea
                      ref={detailsInput}
                      required
                      maxLength={feedbackLimits.text}
                      value={feedback}
                      onChange={(event) => setFeedback(event.target.value)}
                      placeholder={
                        kind === 'bug'
                          ? 'What were you trying to do? What happened instead?'
                          : kind === 'feature'
                            ? 'What would this help you do? How do you handle it today?'
                            : 'Tell us a little more.'
                      }
                      rows={6}
                    />
                  </label>
                  <div className="feedback-attachment-controls">
                    <input
                      type="file"
                      ref={fileInput}
                      hidden
                      multiple
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(event) => {
                        addAttachments(Array.from(event.target.files ?? []));
                        event.target.value = '';
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => fileInput.current?.click()}
                    >
                      <Paperclip size={15} aria-hidden="true" />
                      Add screenshots
                    </Button>
                  </div>
                  {attachments.length > 0 && (
                    <div className="feedback-attachment-list">
                      {attachments.map((file, index) => (
                        <div key={`${file.name}-${index}`}>
                          <Paperclip size={14} aria-hidden="true" />
                          <span>{file.name}</span>
                          <button
                            type="button"
                            aria-label={`Remove ${file.name}`}
                            onClick={() =>
                              setAttachments(attachments.filter((_, value) => value !== index))
                            }
                          >
                            <X size={14} aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="feedback-review-content">
                  {feedback && (
                    <div className="feedback-review-summary">
                      <span className="feedback-type-tag">
                        <category.icon size={14} aria-hidden="true" />
                        {category.short}
                      </span>
                      <p>{feedback}</p>
                      {attachments.length > 0 && (
                        <span className="muted">
                          {attachments.length} screenshot{attachments.length !== 1 ? 's' : ''}{' '}
                          attached
                        </span>
                      )}
                    </div>
                  )}
                  {kind === 'bug' && (!pendingId || submission.current) && (
                    <div
                      className={`feedback-report-block ${hasReport ? '' : 'feedback-report-removed'}`}
                    >
                      <div className="feedback-report-heading">
                        <FileJson size={19} aria-hidden="true" />
                        <div>
                          <strong>Diagnostic report</strong>
                          <span>
                            {!hasReport
                              ? 'Not included'
                              : reportLoading
                                ? 'Preparing…'
                                : report
                                  ? 'Attached automatically'
                                  : 'Couldn’t prepare the report'}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="feedback-text-action"
                          disabled={frozen}
                          onClick={() => {
                            setIncludeReport(!includeReport);
                            setPreview(false);
                          }}
                        >
                          {hasReport ? 'Remove' : 'Include'}
                        </button>
                      </div>
                      {hasReport && report && (
                        <>
                          <p className="feedback-report-disclosure">
                            The Otto team can read the included conversation and diagnostic
                            activity.
                          </p>
                          <button
                            type="button"
                            className="feedback-text-action feedback-preview-toggle"
                            onClick={() => setPreview(!preview)}
                            aria-expanded={preview}
                          >
                            {preview ? 'Hide report' : 'Review report'}
                            <ChevronDown size={14} aria-hidden="true" />
                          </button>
                          {preview && (
                            <div className="feedback-report-preview">
                              <pre aria-label="Diagnostic report">{report.content}</pre>
                            </div>
                          )}
                        </>
                      )}
                      {hasReport && reportError && (
                        <div className="feedback-report-disclosure" role="alert">
                          <p>{reportError}</p>
                          <button
                            type="button"
                            className="feedback-text-action"
                            disabled={frozen || reportLoading}
                            onClick={() => void prepareReport()}
                          >
                            Refresh report
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            {step === 2 && (contextError || (context && !context.enabled)) && (
              <div className="feedback-send-notice" role={contextError ? 'alert' : 'status'}>
                <span>{contextError || 'Sending isn’t enabled in this build.'}</span>
                {contextError && (
                  <button
                    type="button"
                    className="feedback-text-action"
                    disabled={!!busy}
                    onClick={() => setContextAttempt((value) => value + 1)}
                  >
                    Try again
                  </button>
                )}
              </div>
            )}
            {receipt && ['unknown', 'partial'].includes(receipt.status) && (
              <div className="feedback-send-notice" role="alert">
                <strong>
                  {receipt.status === 'partial'
                    ? 'Your feedback was received, but an attachment is missing'
                    : 'We couldn’t confirm the result'}
                </strong>
                <span>
                  {receipt.message ||
                    (receipt.status === 'partial'
                      ? receipt.canRetryAttachments
                        ? 'You can retry the attachments or finish without them.'
                        : 'You can finish without the missing attachments.'
                      : 'Your feedback may have been received. Check its status before sending again.')}
                </span>
                {receipt.issueUrl && (
                  <a href={receipt.issueUrl} target="_blank" rel="noreferrer">
                    View feedback
                  </a>
                )}
                {receipt.status === 'unknown' ? (
                  <button
                    type="button"
                    className="feedback-text-action"
                    disabled={!!busy}
                    onClick={() => void checkStatus()}
                  >
                    {busy === 'checking' ? 'Checking…' : 'Check submission status'}
                  </button>
                ) : (
                  <>
                    {receipt.canRetryAttachments && (
                      <button
                        type="button"
                        className="feedback-text-action"
                        disabled={!!busy}
                        onClick={() => void retryAttachments()}
                      >
                        {busy === 'repairing' ? 'Retrying…' : 'Retry attachments'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="feedback-text-action"
                      disabled={!!busy}
                      onClick={complete}
                    >
                      Finish without attachments
                    </button>
                  </>
                )}
              </div>
            )}
            {error && (
              <p className="feedback-send-notice" role="alert">
                {error}
              </p>
            )}
            <footer className="feedback-footer">
              <div>
                {step > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={frozen}
                    onClick={() => {
                      setStep(step - 1);
                      setError('');
                    }}
                  >
                    <ArrowLeft size={15} aria-hidden="true" />
                    Back
                  </Button>
                ) : development ? (
                  copyButton
                ) : (
                  <span />
                )}
              </div>
              <div>
                {step === 2 && development && copyButton}
                <Button
                  type="submit"
                  disabled={
                    frozen ||
                    (step === 1 && !valid) ||
                    (step === 2 &&
                      (!valid || !context?.enabled || (hasReport && (!report || reportLoading))))
                  }
                >
                  {busy === 'sending' ? (
                    'Sending…'
                  ) : step === 2 ? (
                    <>
                      <Send size={15} aria-hidden="true" />
                      Send feedback
                    </>
                  ) : (
                    <>
                      Continue
                      <ArrowRight size={15} aria-hidden="true" />
                    </>
                  )}
                </Button>
              </div>
            </footer>
          </form>
        </DialogContent>
      </Dialog>
      {toast && (
        <div className="feedback-toast" role="status" aria-live="polite">
          <Check size={18} aria-hidden="true" />
          <span>Thanks for your feedback!</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setToast(false)}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}
