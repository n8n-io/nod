import { useEffect, useRef, useState } from 'react';
import { apiBytes, requestAccountVersion } from '../lib/api';
import { decodeSticker, stickerBytes } from '../lib/sticker';
import { ownedArtifactUrl } from '../lib/attachment-url';
import type { ImagePreview } from './attachment-images';

export function StickerPlayer({ item, onError }: { item: ImagePreview; onError?(): void }) {
  const container = useRef<HTMLSpanElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  const [visible, setVisible] = useState(false);
  const [document, setDocument] = useState('');
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const fail = useRef(onError);
  fail.current = onError;
  useEffect(() => {
    if (!container.current) return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: '100px' },
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const accountVersion = requestAccountVersion();
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animation: Record<string, unknown> | undefined;
    let initialized = false;
    let rendered = false;
    const send = () =>
      frame.current?.contentWindow?.postMessage(
        { type: 'nod:sticker:play', play: !motion.matches && !window.document.hidden },
        '*',
      );
    const receive = (event: MessageEvent) => {
      if (controller.signal.aborted || event.source !== frame.current?.contentWindow) return;
      if (event.data === 'nod:sticker:ready' && !initialized && animation) {
        initialized = true;
        frame.current.contentWindow?.postMessage(
          { type: 'nod:sticker:init', animation, play: !motion.matches && !window.document.hidden },
          '*',
        );
      } else if (event.data === 'nod:sticker:rendered') {
        rendered = true;
        setReady(true);
      } else if (event.data === 'nod:sticker:error') unavailable();
    };
    const unavailable = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      setFailed(true);
      setReady(false);
      fail.current?.();
    };
    setReady(false);
    setFailed(false);
    window.addEventListener('message', receive);
    window.document.addEventListener('visibilitychange', send);
    motion.addEventListener('change', send);
    void (async () => {
      if (!ownedArtifactUrl(item.url) || item.size > stickerBytes)
        throw new Error('Sticker preview unavailable.');
      const [bytes, player] = await Promise.all([
        apiBytes(item.url, stickerBytes, { signal: controller.signal, redirect: 'error' }),
        import('lottie-web/build/player/lottie_light_canvas.min.js?raw'),
      ]);
      animation = await decodeSticker(bytes, controller.signal);
      controller.signal.throwIfAborted();
      if (accountVersion !== requestAccountVersion()) return;
      const code = player.default.replace(/<\/script/gi, '<\\/script');
      loads.current = 0;
      setDocument(
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><style>html,body,#sticker{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block}</style><div id="sticker"></div><script>${code}</script><script>let animation;addEventListener('message',event=>{if(event.source!==parent)return;const data=event.data;if(data?.type==='nod:sticker:init'&&!animation){try{animation=lottie.loadAnimation({container:document.getElementById('sticker'),renderer:'canvas',loop:true,autoplay:false,animationData:data.animation,rendererSettings:{clearCanvas:true,preserveAspectRatio:'xMidYMid meet'}});animation.addEventListener('data_failed',()=>parent.postMessage('nod:sticker:error','*'));animation.addEventListener('error',()=>parent.postMessage('nod:sticker:error','*'));animation.addEventListener('DOMLoaded',()=>{animation.goToAndStop(0,true);if(data.play)animation.play();parent.postMessage('nod:sticker:rendered','*')})}catch{parent.postMessage('nod:sticker:error','*')}}else if(data?.type==='nod:sticker:play'&&animation){data.play?animation.play():animation.pause()}});parent.postMessage('nod:sticker:ready','*')</script>`,
      );
    })().catch(unavailable);
    const timeout = window.setTimeout(() => {
      if (!rendered) unavailable();
    }, 10_000);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
      window.removeEventListener('message', receive);
      window.document.removeEventListener('visibilitychange', send);
      motion.removeEventListener('change', send);
      setDocument('');
    };
  }, [visible, item.url, item.size]);
  if (!ownedArtifactUrl(item.url)) return null;
  return (
    <span className="sticker-player" ref={container} data-sticker-ready={ready || undefined}>
      {visible && document && !failed && (
        <iframe
          ref={frame}
          srcDoc={document}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title="Animated sticker"
          tabIndex={-1}
          aria-hidden="true"
          onLoad={() => {
            if (++loads.current > 1) {
              setFailed(true);
              setReady(false);
              fail.current?.();
            }
          }}
        />
      )}
      {!ready && (
        <span className="sticker-player-status">
          {failed ? 'Sticker preview unavailable' : 'Sticker'}
        </span>
      )}
    </span>
  );
}
