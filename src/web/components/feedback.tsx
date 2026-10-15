import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
} from 'react';
import { Bug, Check, Copy, Lightbulb, MessageCircle, Paperclip, Send, X } from 'lucide-react';
import {
  feedbackAttachmentAccept,
  feedbackAttachmentMimeType,
  feedbackLimits,
  type FeedbackAttachment as SubmittedAttachment,
  type FeedbackContext,
  type FeedbackReceipt,
  type FeedbackReport,
  type FeedbackSubmission,
} from '../../shared/feedback';
import { api, ApiError, errorMessage } from '../lib/api';
import { desktopFeedbackContext } from '../lib/desktop';
import { clipboardFiles } from '../lib/composer-editor';
import type { FeedbackAttachment } from '../lib/feedback-attachment';
import { loadFeedbackDraft, saveFeedbackDraft, type FeedbackDraft } from '../lib/feedback-draft';
import { FeedbackAttachments } from './feedback-attachments';
import { FeedbackDiagnostics } from './feedback-diagnostics';
import { FeedbackEditor, type FeedbackEditorHandle } from './feedback-editor';
import { Button, Dialog, DialogContent, DialogTitle } from './ui';

const categories = [
  { id: 'bug', title: 'Bug or issue', icon: Bug },
  { id: 'feature', title: 'Idea', icon: Lightbulb },
  { id: 'other', title: 'Other', icon: MessageCircle },
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

async function encodeAttachment(file: File): Promise<SubmittedAttachment> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error(`Couldn’t read ${file.name}. Add it again.`));
    reader.readAsDataURL(file);
  });
  return { name: file.name, mimeType: file.type as SubmittedAttachment['mimeType'], data };
}

type FeedbackDialogProps = {
  ownerId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  returnFocus(): HTMLElement | null;
  screenshot?: File | null;
};

function sameDraft(first: FeedbackDraft, second: FeedbackDraft | null) {
  return (
    !!second &&
    first.category === second.category &&
    first.feedback === second.feedback &&
    first.includeReport === second.includeReport &&
    first.attachments === second.attachments &&
    first.pendingId === second.pendingId
  );
}

function hasDraft(draft: FeedbackDraft) {
  return (
    !!draft.feedback ||
    !!draft.attachments.length ||
    draft.category !== 'bug' ||
    !draft.includeReport ||
    !!draft.pendingId
  );
}

export function FeedbackDialog(props: FeedbackDialogProps) {
  return <FeedbackDraftDialog key={props.ownerId} {...props} />;
}

function FeedbackDraftDialog({
  ownerId,
  open,
  onOpenChange,
  returnFocus,
  screenshot,
}: FeedbackDialogProps) {
  const storageKey = `otto.feedback.pending.${ownerId}`;
  const [pendingId, setPendingId] = useState(() => readPending(storageKey));
  const [kind, setKind] = useState<FeedbackSubmission['category']>('bug');
  const [feedback, setFeedback] = useState('');
  const [attachments, setAttachments] = useState<FeedbackAttachment[]>([]);
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
  const [dragging, setDragging] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const active = useRef(true);
  const allowSave = useRef(false);
  const storageVersion = useRef(0);
  const restoreVersion = useRef(0);
  const persisted = useRef<FeedbackDraft | null>(null);
  const dirty = useRef(false);
  const started = useRef(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const detailsInput = useRef<FeedbackEditorHandle>(null);
  const submission = useRef<FeedbackSubmission | null>(null);
  const reportRequest = useRef<{
    controller: AbortController;
    promise: Promise<FeedbackReport | null>;
  } | null>(null);
  const sendRequest = useRef<AbortController | null>(null);
  const copyRequest = useRef<AbortController | null>(null);
  const reportRef = useRef<FeedbackReport | null>(null);
  const frozen = !!busy || !!pendingId || !hydrated || discarding;
  const valid = !!feedback.trim() && feedback.length <= feedbackLimits.text;
  const draft = useMemo<FeedbackDraft>(
    () => ({
      category: kind,
      feedback,
      includeReport,
      attachments,
      pendingId,
    }),
    [kind, feedback, includeReport, attachments, pendingId],
  );
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  dirty.current = hydrated && !sameDraft(draft, persisted.current);

  async function restoreDraft() {
    const version = ++restoreVersion.current;
    setHydrated(false);
    setDraftError('');
    try {
      const saved = await loadFeedbackDraft(ownerId);
      if (!active.current || restoreVersion.current !== version) return;
      const value = saved ?? {
        category: 'bug' as const,
        feedback: '',
        includeReport: true,
        attachments: [],
        pendingId: null,
      };
      const pending = readPending(storageKey) ?? value.pendingId;
      persisted.current = value;
      setKind(value.category);
      setFeedback(value.feedback);
      setIncludeReport(value.includeReport);
      setAttachments(value.attachments);
      setPendingId(pending);
      setReceipt(pending ? { submissionId: pending, status: 'unknown' } : null);
      started.current = !!saved || !!pending;
      allowSave.current = true;
      setRestoreFailed(false);
    } catch {
      if (!active.current || restoreVersion.current !== version) return;
      persisted.current = currentDraft.current;
      started.current = true;
      setRestoreFailed(true);
      setDraftError('Couldn’t restore your saved draft. You can keep writing here.');
    } finally {
      if (active.current && restoreVersion.current === version) setHydrated(true);
    }
  }

  async function persistDraft(value: FeedbackDraft) {
    allowSave.current = true;
    const version = ++storageVersion.current;
    setSavingDraft(true);
    setRestoreFailed(false);
    try {
      await saveFeedbackDraft(ownerId, hasDraft(value) ? value : null);
      if (!active.current || storageVersion.current !== version) return;
      persisted.current = value;
      if (sameDraft(currentDraft.current, value)) {
        dirty.current = false;
        setDraftError('');
      }
    } catch {
      if (active.current && storageVersion.current === version)
        setDraftError(
          'Your draft is kept here, but couldn’t be saved. Keep this window open or try again.',
        );
    } finally {
      if (active.current && storageVersion.current === version) setSavingDraft(false);
    }
  }

  useEffect(() => {
    active.current = true;
    void restoreDraft();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      active.current = false;
      restoreVersion.current++;
      storageVersion.current++;
      window.removeEventListener('beforeunload', beforeUnload);
      if (dirty.current && allowSave.current)
        void saveFeedbackDraft(
          ownerId,
          hasDraft(currentDraft.current) ? currentDraft.current : null,
        ).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (
      !hydrated ||
      discarding ||
      restoreFailed ||
      receipt?.status === 'submitted' ||
      sameDraft(draft, persisted.current)
    )
      return;
    const timer = setTimeout(() => void persistDraft(draft), 250);
    return () => clearTimeout(timer);
  }, [draft, hydrated, discarding, restoreFailed, receipt?.status]);

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
  }, [open, pendingId, storageKey]);

  useEffect(() => {
    if (!open || !hydrated || pendingId || started.current || !screenshot) return;
    started.current = true;
    addAttachments([screenshot]);
  }, [open, hydrated, pendingId, screenshot]);

  useEffect(() => {
    if (open && hydrated && !pendingId) detailsInput.current?.focus({ preventScroll: true });
  }, [open, hydrated]);

  useEffect(() => {
    if (open && valid && includeReport && !pendingId && !reportRef.current) void prepareReport();
  }, [open, valid, includeReport, pendingId]);

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

  function resetDraft() {
    allowSave.current = true;
    const empty: FeedbackDraft = {
      category: 'bug',
      feedback: '',
      includeReport: true,
      attachments: [],
      pendingId: null,
    };
    persisted.current = empty;
    currentDraft.current = empty;
    dirty.current = false;
    writePending(storageKey, null);
    setPendingId(null);
    submission.current = null;
    setReceipt(null);
    setBusy(null);
    started.current = false;
    setKind('bug');
    setFeedback('');
    setAttachments(empty.attachments);
    setIncludeReport(true);
    setReport(null);
    reportRef.current = null;
    setReportError('');
    setPreview(false);
    setError('');
    setDraftError('');
    setRestoreFailed(false);
    setConfirmDiscard(false);
  }

  async function clearDraft(accepted: boolean) {
    if (discarding) return;
    ++storageVersion.current;
    setDiscarding(true);
    setSavingDraft(false);
    try {
      await saveFeedbackDraft(ownerId, null);
      if (!active.current) return;
      resetDraft();
      if (accepted) setToast(true);
      onOpenChange(false);
    } catch {
      if (!active.current) return;
      setDraftError(
        accepted
          ? 'Your feedback was sent, but the saved draft couldn’t be cleared. Try again to remove it from this device.'
          : 'Couldn’t discard the saved draft. Your feedback is still here. Try again.',
      );
    } finally {
      if (active.current) setDiscarding(false);
    }
  }

  function complete() {
    allowSave.current = false;
    setReceipt((current) => current && { ...current, status: 'submitted' });
    void clearDraft(true);
  }

  function applyReceipt(result: FeedbackReceipt) {
    if (result.status === 'submitted') {
      setReceipt(result);
      complete();
      return;
    }
    setReceipt(result);
    if (result.status === 'rejected') {
      writePending(storageKey, null);
      setPendingId(null);
      submission.current = null;
      setError(
        result.message ||
          (feedback || attachments.length
            ? 'Couldn’t send your feedback. Your draft is still here.'
            : 'This submission was not received. Add your feedback to try again.'),
      );
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
    if (includeReport && (!report || Date.parse(report.expiresAt) <= Date.now())) {
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
      const encoded = await Promise.all(attachments.map(({ file }) => encodeAttachment(file)));
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
        reportId: includeReport ? report!.id : null,
        attachments: encoded,
      };
      submission.current = payload;
      id = payload.submissionId;
      writePending(storageKey, id);
      setPendingId(id);
      await persistDraft({ ...currentDraft.current, pendingId: id });
      if (controller.signal.aborted) return;
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

  function attachmentError(files: File[]) {
    if (files.length > feedbackLimits.attachments) return 'You can attach up to 3 files.';
    if (files.some((file) => !feedbackAttachmentMimeType(file)))
      return 'Choose images, PDFs, text, logs, JSON or CSV files.';
    if (files.some((file) => !file.size || file.size > feedbackLimits.attachmentBytes))
      return 'Each file must be between 1 byte and 2 MB.';
    if (files.reduce((total, file) => total + file.size, 0) > feedbackLimits.totalAttachmentBytes)
      return 'Keep the attachments under 4 MB in total.';
    return '';
  }

  function addAttachments(files: File[]) {
    if (frozen || !files.length) return;
    const named = files.map((file, index) => {
      const name = file.name
        .replace(/[\\/\x00-\x1f\x7f]/g, '-')
        .trim()
        .slice(0, 160);
      const type = feedbackAttachmentMimeType(file) ?? file.type;
      return name
        ? new File([file], name, { type, lastModified: file.lastModified })
        : new File(
            [file],
            `attachment-${attachments.length + index + 1}.${type.split('/')[1] || 'txt'}`,
            { type },
          );
    });
    const next = [...attachments, ...named.map((file) => ({ id: crypto.randomUUID(), file }))];
    const failure = attachmentError(next.map(({ file }) => file));
    setError(failure);
    if (!failure) setAttachments(next);
  }

  function paste(event: ClipboardEvent) {
    if (frozen || event.defaultPrevented) return;
    const files = clipboardFiles(event.clipboardData);
    if (!files.length) return;
    if (!event.clipboardData.getData('text/plain')) event.preventDefault();
    addAttachments(files);
  }

  function drop(event: DragEvent) {
    dragDepth.current = 0;
    setDragging(false);
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    if (!frozen) addAttachments(Array.from(event.dataTransfer.files));
  }

  function sendForm(event: FormEvent) {
    event.preventDefault();
    if (!frozen) void send();
  }

  const copyButton = (
    <Button
      type="button"
      variant="ghost"
      disabled={frozen || copyStatus === 'copying'}
      onClick={() => void copyReport()}
    >
      <Copy size={16} aria-hidden="true" />
      {copyStatus === 'copying' ? 'Copying…' : copyStatus === 'copied' ? 'Copied' : 'Copy trace'}
    </Button>
  );

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (busy || discarding) return;
          if (!value && dirty.current && !restoreFailed && receipt?.status !== 'submitted')
            void persistDraft(currentDraft.current);
          onOpenChange(value);
        }}
      >
        <DialogContent
          className="feedback-dialog"
          aria-describedby={undefined}
          data-busy={!!busy || discarding}
          onOpenAutoFocus={(event) => {
            if (detailsInput.current) {
              event.preventDefault();
              detailsInput.current.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            const target = returnFocus();
            if (target?.isConnected) {
              event.preventDefault();
              target.focus({ preventScroll: true });
            }
          }}
        >
          <header className="feedback-header">
            <DialogTitle>Send feedback</DialogTitle>
          </header>
          <form className="feedback-form" onSubmit={sendForm}>
            <div
              className="feedback-body"
              data-dragging={dragging || undefined}
              onPaste={paste}
              onDragEnter={(event) => {
                if (frozen || !event.dataTransfer.types.includes('Files')) return;
                event.preventDefault();
                dragDepth.current++;
                setDragging(true);
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes('Files')) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = frozen ? 'none' : 'copy';
              }}
              onDragLeave={() => {
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (!dragDepth.current) setDragging(false);
              }}
              onDrop={drop}
            >
              {(!pendingId || feedback) && (
                <>
                  <div
                    className="feedback-category-options"
                    role="group"
                    aria-label="Feedback type"
                  >
                    {categories.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        className={`feedback-category-option ${kind === item.id ? 'selected' : ''}`}
                        aria-pressed={kind === item.id}
                        disabled={frozen}
                        onClick={() => {
                          setKind(item.id);
                          setPreview(false);
                        }}
                      >
                        <item.icon size={16} aria-hidden="true" />
                        {item.title}
                      </button>
                    ))}
                  </div>
                  <div className="feedback-composer">
                    <FeedbackEditor
                      ref={detailsInput}
                      disabled={frozen}
                      value={feedback}
                      onChange={setFeedback}
                      onSubmit={() => void send()}
                      onUpload={addAttachments}
                      placeholder={
                        kind === 'bug'
                          ? 'What were you trying to do? What happened instead?'
                          : kind === 'feature'
                            ? 'What would this help you do?'
                            : 'Tell us what’s on your mind.'
                      }
                    />
                    <FeedbackAttachments
                      files={attachments}
                      disabled={frozen}
                      onRemove={(index) => {
                        setAttachments(attachments.filter((_, value) => value !== index));
                        setError('');
                      }}
                      onReplace={(index, file) => {
                        const next = attachments.map((current, value) =>
                          value === index ? file : current,
                        );
                        const failure = attachmentError(next.map(({ file }) => file));
                        setError(failure);
                        if (failure) return false;
                        setAttachments(next);
                        return true;
                      }}
                    />
                    <div className="feedback-composer-toolbar">
                      <input
                        type="file"
                        ref={fileInput}
                        hidden
                        multiple
                        accept={feedbackAttachmentAccept}
                        disabled={frozen}
                        onChange={(event) => {
                          addAttachments(Array.from(event.target.files ?? []));
                          event.target.value = '';
                        }}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={frozen}
                        onClick={() => fileInput.current?.click()}
                      >
                        <Paperclip size={16} aria-hidden="true" />
                        Add files
                      </Button>
                      <span>Paste or drop files</span>
                    </div>
                  </div>
                  {(!pendingId || submission.current) && (
                    <FeedbackDiagnostics
                      included={includeReport}
                      report={report}
                      preview={preview}
                      loading={reportLoading}
                      error={reportError}
                      frozen={frozen}
                      onToggleIncluded={() => {
                        setIncludeReport(!includeReport);
                        setPreview(false);
                      }}
                      onReview={async () => {
                        if (report) setPreview(!preview);
                        else if (!frozen && (await prepareReport())) setPreview(true);
                      }}
                      onRefresh={() => void prepareReport()}
                    />
                  )}
                </>
              )}
            </div>
            {!hydrated && (
              <p className="feedback-draft-status" role="status">
                Restoring your draft…
              </p>
            )}
            {draftError && (
              <div className="feedback-send-notice" role="alert">
                <span>{draftError}</span>
                <button
                  type="button"
                  className="feedback-text-action"
                  disabled={!!busy || discarding || savingDraft}
                  onClick={() => {
                    if (receipt?.status === 'submitted') complete();
                    else if (confirmDiscard) void clearDraft(false);
                    else void persistDraft(currentDraft.current);
                  }}
                >
                  {receipt?.status === 'submitted' || confirmDiscard
                    ? 'Try again'
                    : 'Save this draft'}
                </button>
              </div>
            )}
            {confirmDiscard && (
              <div className="feedback-send-notice" role="alert">
                <strong>Discard this feedback draft?</strong>
                <span>This removes the text and attachments saved on this device.</span>
                <div className="feedback-draft-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={discarding}
                    onClick={() => setConfirmDiscard(false)}
                  >
                    Keep draft
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={discarding}
                    onClick={() => void clearDraft(false)}
                  >
                    {discarding ? 'Discarding…' : 'Discard draft'}
                  </Button>
                </div>
              </div>
            )}
            {(contextError || (context && !context.enabled)) && (
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
              <div className="feedback-footer-actions">
                {development && copyButton}
                {hydrated && hasDraft(draft) && !confirmDiscard && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!!busy || discarding}
                    onClick={() => setConfirmDiscard(true)}
                  >
                    Discard draft
                  </Button>
                )}
              </div>
              <Button
                type="submit"
                disabled={
                  frozen ||
                  !valid ||
                  !context?.enabled ||
                  (includeReport && (!report || reportLoading))
                }
              >
                <Send size={16} aria-hidden="true" />
                {busy === 'sending' ? 'Sending…' : 'Send feedback'}
              </Button>
            </footer>
          </form>
        </DialogContent>
      </Dialog>
      {toast && (
        <div className="feedback-toast" role="status" aria-live="polite">
          <Check size={16} aria-hidden="true" />
          <span>Thanks for your feedback!</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setToast(false)}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}
