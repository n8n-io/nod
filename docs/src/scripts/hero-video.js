const VIDEO_ID = 'cjEK7V9GucQ';

export function startHeroVideo() {
  const frame = document.getElementById('heroVideoFrame');
  const mount = document.getElementById('heroYT');
  const unmute = document.getElementById('heroUnmuteBtn');
  if (!frame || !mount || !unmute) return;

  let player = null;
  let ready = false;
  let inView = false;
  let started = false;

  const play = () => {
    if (started || !ready || !inView) return;
    started = true;
    player.playVideo();
  };

  const create = () => {
    player = new window.YT.Player(mount, {
      host: 'https://www.youtube-nocookie.com',
      videoId: VIDEO_ID,
      playerVars: {
        mute: 1,
        controls: 1,
        rel: 0,
        playsinline: 1,
        loop: 1,
        playlist: VIDEO_ID,
        iv_load_policy: 3,
      },
      events: {
        onReady: () => {
          ready = true;
          play();
          const watch = setInterval(() => {
            if (player.isMuted()) return;
            clearInterval(watch);
            unmute.classList.add('hidden');
          }, 1000);
        },
      },
    });
  };

  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      inView = true;
      play();
    },
    { threshold: 0.5 },
  );
  observer.observe(frame);

  if (window.YT?.Player) {
    create();
  } else {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      create();
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(script);
  }

  unmute.addEventListener('click', () => {
    if (!ready) return;
    player.seekTo(0, true);
    player.unMute();
    player.playVideo();
    unmute.classList.add('hidden');
  });
}
