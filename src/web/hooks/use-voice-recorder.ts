import { useEffect, useRef, useState } from 'react';
import { requestAccountVersion } from '../lib/api';

type RecordingPhase = 'idle' | 'requesting' | 'recording' | 'finishing' | 'preview';

interface Recording {
  file: File;
  url: string;
  duration: number;
}

interface Capture {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  bytes: number;
  started: number;
  duration: number;
  timer?: number;
  context?: AudioContext;
  notice?: string;
}

const durationLimit = 5 * 60_000;
const byteLimit = 20 * 1024 * 1024;

function closeInput(capture: Capture) {
  window.clearInterval(capture.timer);
  for (const track of capture.stream.getTracks()) track.stop();
  if (capture.context) void capture.context.close().catch(() => {});
}

function discardCapture(capture: Capture) {
  capture.recorder.ondataavailable = null;
  capture.recorder.onstop = null;
  capture.recorder.onerror = null;
  try {
    if (capture.recorder.state !== 'inactive') capture.recorder.stop();
  } catch {
  } finally {
    closeInput(capture);
  }
}

async function waveRecording(file: File, context: AudioContext) {
  const decoded = await context.decodeAudioData(await file.arrayBuffer());
  const frames = Math.min(Math.ceil(decoded.duration * 16_000), durationLimit * 16);
  if (!frames) throw new Error('No audio was recorded.');
  const offline = new OfflineAudioContext(1, frames, 16_000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const label = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      view.setUint8(offset + index, value.charCodeAt(index));
  };
  label(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  label(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return new File([bytes], 'Voice message.wav', {
    type: 'audio/wav',
    lastModified: file.lastModified,
  });
}

function microphoneError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      return 'Allow microphone access in your browser or system settings, then try again.';
    if (error.name === 'NotFoundError') return 'Connect a microphone, then try again.';
    if (error.name === 'NotReadableError')
      return 'Your microphone is unavailable. Check that another app is not using it, then try again.';
  }
  return 'The recording could not start. Check your microphone and try again.';
}

export function useVoiceRecorder(scope?: string, targetFormat?: 'wav') {
  const [phase, setPhase] = useState<RecordingPhase>('idle');
  const [recording, setRecording] = useState<Recording | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef<Capture | null>(null);
  const previewUrl = useRef<string | null>(null);
  const recordingValue = useRef<Recording | null>(null);
  const conversionContext = useRef<AudioContext | null>(null);
  const generation = useRef(0);
  const phaseRef = useRef<RecordingPhase>('idle');
  const currentScope = useRef(scope);
  const currentFormat = useRef(targetFormat);
  currentScope.current = scope;
  currentFormat.current = targetFormat;
  const supported =
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia);

  function changePhase(value: RecordingPhase) {
    phaseRef.current = value;
    setPhase(value);
  }

  function release() {
    generation.current++;
    if (active.current) discardCapture(active.current);
    active.current = null;
    if (conversionContext.current) void conversionContext.current.close().catch(() => {});
    conversionContext.current = null;
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
    recordingValue.current = null;
  }

  function discard() {
    release();
    changePhase('idle');
    setRecording(null);
    setElapsed(0);
    setLevel(0);
    setError('');
    setNotice('');
  }

  function fail(message: string) {
    discard();
    setError(message);
  }

  async function prepare() {
    const value = recordingValue.current;
    if (!value) return null;
    if (currentFormat.current !== 'wav' || value.file.type === 'audio/wav') return value.file;
    const operation = generation.current;
    const account = requestAccountVersion();
    let context: AudioContext | undefined;
    changePhase('finishing');
    setError('');
    try {
      context = new AudioContext();
      conversionContext.current = context;
      const file = await waveRecording(value.file, context);
      if (operation !== generation.current || account !== requestAccountVersion()) return null;
      const url = URL.createObjectURL(file);
      URL.revokeObjectURL(value.url);
      previewUrl.current = url;
      recordingValue.current = { ...value, file, url };
      setRecording(recordingValue.current);
      changePhase('preview');
      return file;
    } catch {
      if (operation === generation.current) {
        setError(
          'Your recording could not be prepared. It is still here. Prepare audio to retry, or record a new message.',
        );
        changePhase('preview');
      }
      return null;
    } finally {
      if (context) void context.close().catch(() => {});
      if (conversionContext.current === context) conversionContext.current = null;
    }
  }

  function stop() {
    const capture = active.current;
    if (!capture || phaseRef.current !== 'recording') return;
    capture.duration = Math.min(performance.now() - capture.started, durationLimit);
    changePhase('finishing');
    setElapsed(capture.duration);
    setLevel(0);
    try {
      capture.recorder.stop();
      closeInput(capture);
    } catch {
      fail('The recording could not be saved. Try recording it again.');
    }
  }

  async function start() {
    if (phaseRef.current !== 'idle' && phaseRef.current !== 'preview') return;
    if (!supported) {
      setError('This browser cannot record audio. Try another browser.');
      return;
    }
    discard();
    const operation = generation.current;
    const account = requestAccountVersion();
    const startedScope = currentScope.current;
    changePhase('requesting');
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (
        operation !== generation.current ||
        account !== requestAccountVersion() ||
        startedScope !== currentScope.current
      ) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const mimeType = [
        'audio/webm;codecs=opus',
        'audio/mp4',
        'audio/ogg;codecs=opus',
        'audio/webm',
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 128_000,
      });
      const capture: Capture = {
        recorder,
        stream,
        chunks: [],
        bytes: 0,
        started: performance.now(),
        duration: 0,
      };
      active.current = capture;
      recorder.ondataavailable = (event) => {
        if (active.current !== capture || !event.data.size) return;
        capture.bytes += event.data.size;
        if (capture.bytes > byteLimit) {
          fail('The recording is too large. Try a shorter message.');
          return;
        }
        capture.chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (active.current === capture)
          fail('Recording stopped unexpectedly. Try recording it again.');
      };
      recorder.onstop = async () => {
        if (active.current !== capture || operation !== generation.current) return;
        if (account !== requestAccountVersion() || startedScope !== currentScope.current) {
          discard();
          return;
        }
        closeInput(capture);
        active.current = null;
        if (!capture.bytes) {
          fail('No audio was recorded. Check your microphone and try again.');
          return;
        }
        const type = recorder.mimeType || capture.chunks[0]?.type || mimeType || 'audio/webm';
        const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const file = new File(capture.chunks, `Voice message.${extension}`, { type });
        const url = URL.createObjectURL(file);
        previewUrl.current = url;
        recordingValue.current = { file, url, duration: capture.duration };
        setRecording(recordingValue.current);
        setNotice(capture.notice ?? '');
        if (currentFormat.current === 'wav') await prepare();
        else changePhase('preview');
      };
      let analyser: AnalyserNode | undefined;
      let samples: Uint8Array<ArrayBuffer> | undefined;
      try {
        capture.context = new AudioContext();
        analyser = capture.context.createAnalyser();
        analyser.fftSize = 256;
        capture.context.createMediaStreamSource(stream).connect(analyser);
        samples = new Uint8Array(analyser.fftSize);
        void capture.context.resume().catch(() => {});
      } catch {}
      recorder.start(250);
      changePhase('recording');
      for (const track of stream.getAudioTracks()) track.onended = stop;
      capture.timer = window.setInterval(() => {
        if (account !== requestAccountVersion() || startedScope !== currentScope.current) {
          discard();
          return;
        }
        const duration = performance.now() - capture.started;
        setElapsed(Math.min(duration, durationLimit));
        if (duration >= durationLimit) {
          capture.notice = 'Recording stopped at 5 minutes. Listen before sending.';
          stop();
          return;
        }
        if (analyser && samples) {
          analyser.getByteTimeDomainData(samples);
          const power = samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0);
          setLevel(Math.min(1, Math.sqrt(power / samples.length) * 5));
        }
      }, 100);
    } catch (cause) {
      if (stream) for (const track of stream.getTracks()) track.stop();
      if (operation === generation.current) fail(microphoneError(cause));
    }
  }

  useEffect(() => {
    discard();
    const leave = () => discard();
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      release();
    };
  }, [scope]);

  return {
    phase,
    recording,
    elapsed,
    level,
    error,
    notice,
    supported,
    start,
    stop,
    discard,
    prepare,
    needsPreparation:
      targetFormat === 'wav' && Boolean(recording && recording.file.type !== 'audio/wav'),
    clearError: () => setError(''),
  };
}
