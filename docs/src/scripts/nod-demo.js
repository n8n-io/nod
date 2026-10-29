const hello = { who: 'nod', text: "👋 Hey, I'm Nod, your personal agent." };
const conversations = [
  {
    items: [
      {
        who: 'nod',
        text: 'I read your recent inbox. I can take these off your plate:',
        list: [
          { title: 'Collect Q3 invoices', meta: 'From 6 supplier portals, due Friday' },
          { title: 'Book flights for the Lisbon offsite', meta: 'Tue to Fri, fares are going up' },
          { title: 'Chase 3 unpaid invoices', meta: '€4,120 overdue' },
        ],
      },
      { who: 'you', text: 'Do all three.' },
      { who: 'nod', text: 'On it. Starting with the invoices.' },
    ],
  },
  {
    intro: [{ who: 'you', text: 'Collect the Q3 invoices from our 6 supplier portals.' }],
    items: [
      { who: 'step', text: 'Signed in to 6 supplier portals' },
      { who: 'step', text: 'Downloaded 41 invoices' },
      { who: 'step', text: 'Renamed them by supplier and date' },
      { who: 'step', text: 'Filed them in Drive › Accounting › Q3' },
      {
        who: 'nod',
        text: 'Invoices done. 41 filed, and one portal had nothing for Q3.',
        nod: true,
      },
    ],
  },
  {
    intro: [{ who: 'you', text: 'Book my flights for the Lisbon offsite.' }],
    items: [
      {
        who: 'nod',
        text: 'Flights for Lisbon: Tue 08:40, back Fri 18:10, aisle seats. €212 return. Book it?',
      },
      { who: 'you', text: 'Book it.' },
      { who: 'step', text: "You approved €212 with your card's security code" },
      {
        who: 'nod',
        text: 'Booked, tickets are in your inbox. The 3 reminders went out too. That was all three.',
        nod: true,
      },
    ],
  },
  {
    items: [
      { who: 'you', text: 'Nice. Can you run on my own model?' },
      { who: 'nod', text: "Yes. I'm open source, so you choose what runs me.", models: true },
    ],
  },
];

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

export function startDemo() {
  const feed = document.getElementById('feed');
  const typing = document.getElementById('typing');
  const chip = document.getElementById('model');
  const caps = [...document.querySelectorAll('.cap')];
  const providers = [...document.querySelectorAll('.provider')];
  const models = providers.map((button) => ({
    key: button.dataset.key,
    name: button.dataset.name,
    note: button.dataset.note,
  }));
  const local = models.findIndex((entry) => entry.key === 'local');
  const first = providers.findIndex((button) => button.classList.contains('on'));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let timers = [];
  let current = -1;
  let fading = false;
  let model = first;
  let picker = null;
  let previous = null;

  const later = (run, ms) => timers.push(setTimeout(run, ms));
  const clear = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };
  const setTyping = (on) => typing.classList.toggle('on', on);
  const setCurrent = (index) => {
    current = index;
    caps.forEach((cap, i) => cap.classList.toggle('active', i === index));
  };

  function lockPicker() {
    if (picker) picker.querySelectorAll('button').forEach((button) => (button.disabled = true));
    picker = null;
  }

  function choose(index) {
    if (!picker) return;
    clear();
    lockPicker();
    model = index;
    chip.textContent = models[index].name;
    document.querySelectorAll('.option').forEach((option) => option.classList.remove('on'));
    document
      .querySelectorAll(`.option[data-index="${index}"]`)
      .forEach((option) => option.classList.add('on'));
    push({ who: 'you', text: models[index].name });
    later(() => setTyping(true), 500);
    later(() => {
      setTyping(false);
      push({
        who: 'nod',
        nod: true,
        text:
          index === local
            ? 'Switched. Same memory, same jobs, now running on your computer.'
            : `Switched to ${models[index].name}. Same memory, same jobs.`,
      });
      next(3800);
    }, 1500);
  }

  function attachments(message) {
    if (message.list) {
      const sheet = node('div', 'sheet list');
      for (const row of message.list) {
        const item = node('div', 'item');
        const text = node('span', 'text');
        text.append(node('b', '', row.title), node('small', '', row.meta));
        item.append(text, node('span', 'pill', 'Hand off'));
        sheet.append(item);
      }
      return sheet;
    }
    if (message.models) {
      const sheet = node('div', 'sheet options');
      models.forEach((entry, index) => {
        const option = node('button', index === model ? 'option on' : 'option');
        option.type = 'button';
        option.dataset.index = index;
        option.append(
          node('span', 'radio'),
          node('b', '', entry.name),
          node('small', '', entry.note),
        );
        option.addEventListener('click', () => choose(index));
        sheet.append(option);
      });
      picker = sheet;
      return sheet;
    }
    return null;
  }

  function push(message) {
    const grow = document.createElement('nod-grow');
    if (message.who === 'you') {
      const row = node('div', 'you');
      row.append(node('p', '', message.text));
      grow.append(row);
    } else if (message.who === 'step') {
      grow.append(node('div', 'step', message.text));
    } else {
      const first = previous !== 'nod';
      const wrapper = node('div', first ? 'from-nod first' : 'from-nod');
      const row = node('div', 'row');
      const avatar = node('span', 'avatar');
      if (first || message.nod) {
        const glyph = document.createElement('nod-glyph');
        glyph.setAttribute('size', '26');
        glyph.setAttribute('delay', '350');
        if (message.nod) glyph.setAttribute('nod-on', 'view');
        avatar.append(glyph);
      }
      row.append(avatar, node('p', 'bubble', message.text));
      wrapper.append(row);
      grow.append(wrapper);
      const extra = attachments(message);
      if (extra) {
        const attached = node('div', 'attached');
        attached.append(extra);
        grow.append(attached);
      }
    }
    previous = message.who;
    feed.append(grow);
    while (feed.children.length > 40) feed.firstElementChild.remove();
  }

  function restart() {
    feed.replaceChildren();
    previous = null;
    picker = null;
  }

  function next(wait) {
    if (current + 1 < conversations.length) {
      later(() => run(current + 1, true), wait || 1600);
      return;
    }
    later(() => {
      fading = true;
      feed.classList.add('fade');
    }, 5200);
    later(() => {
      restart();
      fading = false;
      feed.classList.remove('fade');
      setCurrent(-1);
      push(hello);
      later(() => run(0, true), 1600);
    }, 5900);
  }

  function run(index, continuing) {
    clear();
    setCurrent(index);
    setTyping(false);
    lockPicker();
    const conversation = conversations[index];
    const items =
      !continuing && conversation.intro
        ? [...conversation.intro, ...conversation.items]
        : conversation.items;
    const step = (i) => {
      if (i >= items.length) return next(2200);
      const item = items[i];
      if (item.who === 'you' || item.who === 'step') {
        push(item);
        later(() => step(i + 1), item.who === 'you' ? 1200 : 1000);
        return;
      }
      setTyping(true);
      later(
        () => {
          setTyping(false);
          push(item);
          if (item.models) {
            later(() => choose(model === local ? first : local), 3600);
            return;
          }
          later(() => step(i + 1), 1300 + item.text.length * 14 + (item.list ? 2200 : 0));
        },
        1100 + Math.min(500, item.text.length * 6),
      );
    };
    step(0);
  }

  function select(index) {
    if (index === current && !fading) return;
    clear();
    setCurrent(index);
    setTyping(false);
    fading = true;
    feed.classList.add('fade');
    later(() => {
      restart();
      fading = false;
      feed.classList.remove('fade');
      run(index, false);
    }, 320);
  }

  caps.forEach((cap, index) => cap.addEventListener('click', () => select(index)));
  providers.forEach((button) =>
    button.addEventListener('click', () => {
      providers.forEach((other) => {
        other.classList.toggle('on', other === button);
        other.setAttribute('aria-pressed', String(other === button));
      });
    }),
  );

  push(hello);
  if (reduced) {
    conversations[0].items.slice(0, 2).forEach(push);
    setCurrent(0);
    return;
  }
  later(() => run(0, true), 1600);
}
