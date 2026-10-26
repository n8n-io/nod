if (new URLSearchParams(window.location.search).get('service') === 'gmail') {
  document.getElementById('title').textContent = 'Opening Gmail sign-in…';
  document.title = 'Opening Gmail sign-in · Nod';
}
