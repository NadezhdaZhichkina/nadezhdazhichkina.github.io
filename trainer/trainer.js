const gate = document.querySelector('#gate');
const access = document.querySelector('#access');
const keyField = document.querySelector('#access-key');
const accessMessage = document.querySelector('#access-message');
const app = document.querySelector('#app');
const navigation = document.querySelector('#navigation');
const lockButton = document.querySelector('#lock');
const storageMessage = document.querySelector('#storage-message');
const sessionSlot = 'asiwi.trainer.session.v1';
const progressPrefix = 'asiwi.trainer.progress.v1.';
const decoder = new TextDecoder();
const encoder = new TextEncoder();

let key = null;
let deck = null;
let unlockInProgress = false;
let history = new Map();
const pendingWrites = new Map();

function element(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

function link(label, href, className = '') {
  return element('a', { href, class: className }, label);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
}

function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

async function decrypt(envelope, decryptionKey) {
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(envelope.iv) },
    decryptionKey,
    fromBase64(envelope.ciphertext),
  );
  return JSON.parse(decoder.decode(raw));
}

async function encrypt(record, encryptionKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, encryptionKey, encoder.encode(JSON.stringify(record)),
  );
  return JSON.stringify({ iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) });
}

function manageSession(token) {
  try {
    if (token) sessionStorage.setItem(sessionSlot, token);
    else sessionStorage.removeItem(sessionSlot);
  } catch {
    // The current page also works in browsers that disable session storage.
  }
}

function progressId(scenario, index) {
  return progressPrefix + scenario.id + '.' + index;
}

function recordFor(scenario, index) {
  return history.get(progressId(scenario, index));
}

async function restoreProgress(course, decryptionKey) {
  const entries = course.scenarios.flatMap(scenario =>
    scenario.moves.map(async (_, index) => {
      const id = progressId(scenario, index);
      try {
        const saved = localStorage.getItem(id);
        if (!saved) return null;
        const record = await decrypt(JSON.parse(saved), decryptionKey);
        if ((record.answer === null || record.answer === 0 || record.answer === 1) &&
            typeof record.note === 'string') {
          return [id, record];
        }
      } catch {
        // Invalid or older records can be skipped independently of the rest.
      }
      return null;
    }),
  );
  return new Map((await Promise.all(entries)).filter(Boolean));
}

function saveProgress(scenario, index, record) {
  const id = progressId(scenario, index);
  history.set(id, record);
  const encryptionKey = key;
  const task = encrypt(record, encryptionKey)
    .then(envelope => {
      if (pendingWrites.get(id) === task) localStorage.setItem(id, envelope);
    })
    .catch(() => {
      storageMessage.textContent = 'Браузер не смог сохранить новый прогресс. Он доступен в этой вкладке до закрытия.';
    })
    .finally(() => {
      if (pendingWrites.get(id) === task) pendingWrites.delete(id);
    });
  pendingWrites.set(id, task);
  return task;
}

async function unlock(token) {
  if (unlockInProgress) return;
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) {
    accessMessage.textContent = 'Вставь ключ доступа целиком.';
    return;
  }
  if (!globalThis.crypto?.subtle) {
    accessMessage.textContent = 'Открой тренажёр по HTTPS в браузере с поддержкой шифрования.';
    return;
  }

  unlockInProgress = true;
  const submit = access.querySelector('button');
  submit.disabled = true;
  submit.textContent = 'Открываем…';
  accessMessage.textContent = '';
  try {
    const response = await fetch('./content.enc.json');
    if (!response.ok) throw new Error('Сервер не отдал материалы');
    const encryptionKey = await crypto.subtle.importKey(
      'raw', fromBase64(token), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
    );
    const envelope = await response.json();
    const course = await decrypt(envelope, encryptionKey);
    if (course.version !== 1) throw new Error('Неподдерживаемая версия материалов');
    for (const scenario of course.scenarios) {
      scenario.moves = scenario.stages.flatMap((stage, stageIndex) =>
        stage.moves.map((move, moveIndex) => ({ ...move, stageIndex, moveIndex, stage: stage.title })),
      );
    }
    const restored = await restoreProgress(course, encryptionKey);
    history = restored;
    key = encryptionKey;
    deck = course;
    manageSession(token);
    keyField.value = '';
    gate.hidden = true;
    app.hidden = false;
    navigation.hidden = false;
    lockButton.hidden = false;
    storageMessage.hidden = false;
    storageMessage.textContent = 'Прогресс и заметки хранятся в этом браузере.';
    renderRoute();
  } catch (error) {
    manageSession(null);
    accessMessage.textContent = error.name === 'OperationError'
      ? 'Ключ не подошёл. Проверь, что вставила его целиком.'
      : 'Не удалось открыть материалы. Проверь подключение и попробуй ещё раз.';
  } finally {
    submit.disabled = false;
    submit.textContent = 'Открыть тренажёр';
    unlockInProgress = false;
  }
}

async function lock() {
  lockButton.disabled = true;
  await Promise.all(pendingWrites.values());
  manageSession(null);
  key = null;
  deck = null;
  history.clear();
  app.replaceChildren();
  app.hidden = true;
  navigation.hidden = true;
  lockButton.hidden = true;
  lockButton.disabled = false;
  storageMessage.hidden = true;
  gate.hidden = false;
  keyField.focus();
}

function answered(scenario) {
  return scenario.moves.filter((_, index) => Number.isInteger(recordFor(scenario, index)?.answer)).length;
}

function nextIndex(scenario) {
  const index = scenario.moves.findIndex((_, i) => !Number.isInteger(recordFor(scenario, i)?.answer));
  return index === -1 ? scenario.moves.length : index;
}

function scenarioUrl(scenario, index = nextIndex(scenario)) {
  return '#play/' + scenario.id + '/' + index;
}

function progress(value, max, label) {
  return element('progress', { value, max, 'aria-label': label });
}

function breadcrumb(destination, label, current) {
  return element('nav', { class: 'breadcrumb', 'aria-label': 'Хлебные крошки' },
    link(label, destination),
    element('span', { 'aria-hidden': 'true' }, '/'),
    element('span', { 'aria-current': 'page' }, current),
  );
}

function renderDashboard() {
  const done = deck.scenarios.reduce((total, scenario) => total + answered(scenario), 0);
  const total = deck.scenarios.reduce((sum, scenario) => sum + scenario.moves.length, 0);
  const intro = element('section', { class: 'intro dashboard-intro' },
    element('div', {},
      element('p', { class: 'eyebrow' }, 'Личный практикум'),
      element('h1', {}, 'Тренажёр продакта'),
      element('p', { class: 'intro-text' }, 'Выбирай ход, записывай прогноз и смотри, что произойдёт в учебном сценарии.'),
      link('Как проходить тренажёр', '#read/decisions', 'btn intro-action'),
    ),
    element('div', { class: 'overview' },
      element('span', {}, 'Твой прогресс'),
      element('strong', {}, done + ' / ' + total),
      progress(done, total, 'Пройдено решений во всех сценариях'),
      element('span', {}, 'Разобрано решений'),
    ),
  );
  const cards = deck.scenarios.map(scenario => {
    const count = answered(scenario);
    const max = scenario.moves.length;
    const action = count === max ? 'Открыть журнал' : count ? 'Продолжить' : 'Начать сценарий';
    return element('article', { class: 'surface scenario-card' },
      element('span', { class: 'tag' }, scenario.category),
      element('h3', {}, scenario.title),
      element('p', {}, scenario.brief),
      element('div', { class: 'scenario-progress' },
        element('p', {}, scenario.stages.length + ' этапов · ' + count + ' из ' + max + ' решений'),
        progress(count, max, 'Прогресс в ' + scenario.title),
      ),
      link(action, scenarioUrl(scenario), 'btn'),
    );
  });
  app.replaceChildren(intro,
    element('div', { class: 'heading-row' }, element('h2', {}, 'Выбери сценарий')),
    element('div', { class: 'scenario-grid' }, ...cards),
  );
}

function renderArticles() {
  const cards = deck.articles.map(article =>
    element('article', { class: 'surface article-card' },
      element('h3', {}, article.title),
      element('p', {}, article.subtitle),
      link('Читать', '#read/' + article.id, 'btn'),
    ),
  );
  app.replaceChildren(element('section', { class: 'articles-page' },
    element('h1', {}, 'Учебные статьи'),
    element('div', { class: 'article-grid' }, ...cards),
  ));
}

function renderArticle(article) {
  const content = element('article', { class: 'surface reading' },
    element('h1', {}, article.title),
    element('p', { class: 'article-intro' }, article.subtitle),
  );
  let check;
  for (const paragraph of article.paragraphs) {
    switch (paragraph.kind) {
      case 'H': content.append(element('h2', {}, paragraph.text)); break;
      case 'Q': check = paragraph.text; break;
      case 'R': content.append(element('details', {},
        element('summary', {}, check), element('p', {}, paragraph.text),
      )); break;
      default: content.append(element('p', {}, paragraph.text));
    }
  }
  app.replaceChildren(breadcrumb('#articles', 'Статьи', article.title), content);
}

function renderStages(scenario, index) {
  const currentStage = scenario.moves[index]?.stageIndex;
  const allowedLast = nextIndex(scenario);
  const steps = scenario.stages.map((stage, i) => {
    const first = i * 3;
    const count = stage.moves.filter((_, j) => Number.isInteger(recordFor(scenario, first + j)?.answer)).length;
    const title = (i + 1) + '. ' + stage.title + (count === 3 ? ' ✓' : '');
    if (first > allowedLast) return element('li', {}, element('span', {}, title));
    const target = count === 3 ? first : allowedLast;
    const item = link(title, scenarioUrl(scenario, target));
    if (i === currentStage) item.setAttribute('aria-current', 'step');
    return element('li', {}, item);
  });
  return element('aside', { class: 'surface case-sidebar' },
    element('h2', {}, 'Этапы сценария'),
    element('p', {}, 'Разобрано ' + answered(scenario) + ' из ' + scenario.moves.length),
    progress(answered(scenario), scenario.moves.length, 'Прогресс сценария'),
    element('ol', { class: 'stage-list' }, ...steps),
  );
}

function renderQuestion(scenario, index, move, record) {
  const fieldset = element('fieldset', {}, element('legend', {}, 'Что сделаешь?'));
  move.options.forEach((option, i) => {
    const attr = { type: 'radio', name: 'decision', value: i, required: '' };
    fieldset.append(element('label', { class: 'option' }, element('input', attr), element('span', {}, option)));
  });
  const notes = element('textarea', { name: 'note', rows: '3', maxlength: '1000', 'aria-describedby': 'note-hint' });
  notes.value = record?.note || '';
  const label = element('label', { class: 'note-label' },
    'Твой прогноз',
    element('span', { id: 'note-hint' }, 'По желанию. На что опираешься и чего ждёшь от хода?'),
    notes,
  );
  const submit = element('button', { type: 'submit', class: 'btn btn-primary' }, 'Посмотреть последствия');
  const form = element('form', {}, fieldset, label, submit);
  notes.addEventListener('input', () => {
    saveProgress(scenario, index, { answer: null, note: notes.value });
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const value = new FormData(form).get('decision');
    if (value !== '0' && value !== '1') return;
    submit.disabled = true;
    notes.readOnly = true;
    await saveProgress(scenario, index, { answer: Number(value), note: notes.value });
    if (!deck || !form.isConnected) return;
    renderRoute({ focus: '#feedback-title' });
  });
  return form;
}

function renderFeedback(scenario, index, move, record) {
  const other = 1 - record.answer;
  const final = index + 1 === scenario.moves.length;
  const next = link(final ? 'Открыть итог сценария' : 'Следующее решение', scenarioUrl(scenario, index + 1), 'btn btn-primary');
  const feedback = element('section', { class: 'feedback', 'aria-labelledby': 'feedback-title' },
    element('h2', { id: 'feedback-title' }, 'Последствие твоего хода'),
    element('p', { class: 'selected-action' }, move.options[record.answer]),
    element('p', {}, move.consequences[record.answer]),
    element('details', {},
      element('summary', {}, 'Что дал бы другой вариант'),
      element('p', {}, move.options[other]),
      element('p', {}, move.consequences[other]),
    ),
  );
  if (record.note) {
    feedback.append(element('details', {},
      element('summary', {}, 'Твой прогноз'),
      element('p', { class: 'answer-note' }, record.note),
    ));
  }
  return [feedback, element('div', { class: 'task-actions' }, next)];
}

function renderJournal(scenario) {
  const log = element('details', { class: 'journal' }, element('summary', {}, 'Все решения и прогнозы'));
  const list = element('ol');
  scenario.moves.forEach((move, index) => {
    const record = recordFor(scenario, index);
    if (Number.isInteger(record?.answer)) {
      list.append(element('li', {}, link(move.stage + ' · ход ' + (move.moveIndex + 1), scenarioUrl(scenario, index))));
    }
  });
  log.append(list);
  return [
    element('h1', {}, 'Сценарий завершён'),
    element('p', { class: 'open-question' }, 'Разобрано ' + answered(scenario) + ' из ' + scenario.moves.length + ' решений.'),
    element('p', {}, 'Выбери три хода, где результат отличался от ожиданий. Что могло изменить твой прогноз и куда ты направила бы ресурсы в следующий раз?'),
    log,
    element('div', { class: 'task-actions' }, link('К сценариям', '#scenarios', 'btn btn-primary')),
  ];
}

function renderCase(scenario, index) {
  const move = scenario.moves[index];
  const record = recordFor(scenario, index);
  const content = element('article', { class: 'surface case-content' });
  if (move) {
    content.append(element('div', { class: 'case-title' },
      element('p', { class: 'step-indicator' },
        'Этап ' + (move.stageIndex + 1) + ' из ' + scenario.stages.length +
        ' · решение ' + (index + 1) + ' из ' + scenario.moves.length),
      element('h1', {}, move.stage),
      element('p', {}, scenario.brief),
    ));
    content.append(element('p', { class: 'open-question' }, move.question));
    if (Number.isInteger(record?.answer)) content.append(...renderFeedback(scenario, index, move, record));
    else content.append(renderQuestion(scenario, index, move, record));
  } else {
    content.append(...renderJournal(scenario));
  }
  app.replaceChildren(
    breadcrumb('#scenarios', 'Сценарии', scenario.title),
    element('div', { class: 'content-layout' }, content, renderStages(scenario, index)),
  );
}

function renderRoute({ focus = '#app h1' } = {}) {
  if (!deck) return;
  const [view, id, position] = location.hash.slice(1).split('/');
  const scenario = view === 'play' && deck.scenarios.find(item => item.id === id);
  const article = view === 'read' && deck.articles.find(item => item.id === id);
  if (scenario) {
    const available = nextIndex(scenario);
    const index = /^\d+$/.test(position || '') ? Math.min(Number(position), available) : available;
    renderCase(scenario, index);
  } else if (article) {
    renderArticle(article);
  } else if (view === 'articles') {
    renderArticles();
  } else {
    renderDashboard();
  }
  const activeNav = article || view === 'articles' ? 'articles' : 'scenarios';
  for (const anchor of navigation.querySelectorAll('a')) {
    if (anchor.dataset.nav === activeNav) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  }
  const heading = document.querySelector(focus);
  heading?.setAttribute('tabindex', '-1');
  heading?.focus({ preventScroll: true });
  if (focus === '#feedback-title') heading?.scrollIntoView({ block: 'nearest' });
  else window.scrollTo({ top: 0, behavior: 'instant' });
}

access.addEventListener('submit', event => {
  event.preventDefault();
  unlock(keyField.value.trim());
});
lockButton.addEventListener('click', lock);
window.addEventListener('hashchange', () => renderRoute());
document.querySelector('.skip').addEventListener('click', event => {
  event.preventDefault();
  document.querySelector('#main').focus();
});
try {
  const previousSession = sessionStorage.getItem(sessionSlot);
  if (previousSession) unlock(previousSession);
} catch {
  // The access form remains available.
}
