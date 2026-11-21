import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { LoaderCircle, Phone, PhoneOff } from './icons';
import { Button } from './ui';

type Live = {
  peer: RTCPeerConnection;
  stream: MediaStream;
  audio: HTMLAudioElement;
  callId?: string;
};

const hangUp = (callId: string) =>
  api(`/api/voice/calls/${encodeURIComponent(callId)}`, { method: 'DELETE' }).catch(() => {});

export function VoiceCallButton({
  threadId,
  microphoneId,
  disabled,
  onError,
}: {
  threadId: string;
  microphoneId?: string;
  disabled: boolean;
  onError(message: string): void;
}) {
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'live'>('idle');
  const live = useRef<Live | null>(null);

  function end() {
    const current = live.current;
    live.current = null;
    setPhase('idle');
    if (!current) return;
    current.peer.close();
    for (const track of current.stream.getTracks()) track.stop();
    current.audio.srcObject = null;
    if (current.callId) void hangUp(current.callId);
  }
  useEffect(() => end, []);

  async function start() {
    onError('');
    setPhase('connecting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: microphoneId ? { deviceId: { exact: microphoneId } } : true,
      });
      const peer = new RTCPeerConnection();
      const audio = new Audio();
      audio.autoplay = true;
      const current: Live = { peer, stream, audio };
      live.current = current;
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      };
      peer.onconnectionstatechange = () => {
        if (live.current === current && ['failed', 'closed'].includes(peer.connectionState)) {
          end();
          onError('The voice call ended because the connection was lost.');
        }
      };
      for (const track of stream.getTracks()) peer.addTrack(track, stream);
      await peer.setLocalDescription(await peer.createOffer());
      const answer = await api<{ callId: string; sdp: string }>('/api/voice/calls', {
        method: 'POST',
        body: JSON.stringify({ sdp: peer.localDescription!.sdp, threadId }),
      });
      if (live.current !== current) return void hangUp(answer.callId);
      current.callId = answer.callId;
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      setPhase('live');
    } catch (cause) {
      end();
      onError(
        cause instanceof DOMException && cause.name === 'NotAllowedError'
          ? 'Allow microphone access to start a voice call.'
          : errorMessage(cause),
      );
    }
  }

  const calling = phase !== 'idle';
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={`call-button${calling ? ' is-calling' : ''}`}
      aria-label={calling ? 'End voice call' : 'Start voice call'}
      title={calling ? 'End voice call' : 'Talk with Nod in a live voice call'}
      aria-pressed={calling}
      disabled={disabled && !calling}
      onClick={() => (calling ? end() : void start())}
    >
      {phase === 'connecting' ? (
        <LoaderCircle size={18} className="spin" />
      ) : calling ? (
        <PhoneOff size={18} />
      ) : (
        <Phone size={18} />
      )}
    </Button>
  );
}
