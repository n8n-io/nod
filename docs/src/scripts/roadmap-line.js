export function startRoadmapLine() {
  const track = document.getElementById('roadmapTrack');
  const line = document.getElementById('roadmapConnector');
  if (!track || !line) return;
  const place = () => {
    const dots = track.querySelectorAll('.lp-circle-pink, .lp-circle-grey');
    if (dots.length < 2) return;
    const box = track.getBoundingClientRect();
    const first = dots[0].getBoundingClientRect();
    const last = dots[dots.length - 1].getBoundingClientRect();
    const top = first.top + first.height / 2 - box.top;
    line.style.left = `${first.left + first.width / 2 - box.left - line.offsetWidth / 2}px`;
    line.style.top = `${top}px`;
    line.style.height = `${last.top + last.height / 2 - box.top - top}px`;
  };
  place();
  window.addEventListener('resize', place);
  window.addEventListener('load', place);
  document.fonts?.ready.then(place);
}
