/*
  Клиентское приложение для загрузки теста (JSON/CSV/MD), прохождения и подсчёта результата
*/

const state = {
  quiz: null,
  currentIndex: 0,
  answers: new Map(), // key: questionIndex, value: Set of option indices
  started: false
};

// DOM
const fileInput = document.getElementById('fileInput');
const pickFileBtn = document.getElementById('pickFileBtn');
const dropZone = document.getElementById('dropZone');
const loadError = document.getElementById('loadError');
const startBtn = document.getElementById('startBtn');
const quizMeta = document.getElementById('quizMeta');

const quizSection = document.getElementById('quiz-section');
const quizTitle = document.getElementById('quizTitle');
const progressEl = document.getElementById('progress');
const questionContainer = document.getElementById('questionContainer');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const submitBtn = document.getElementById('submitBtn');

const resultsSection = document.getElementById('results-section');
const resultsSummary = document.getElementById('resultsSummary');
const resultsDetails = document.getElementById('resultsDetails');
const restartBtn = document.getElementById('restartBtn');
const downloadReportBtn = document.getElementById('downloadReportBtn');
const downloadJsonBtn = document.getElementById('downloadJsonBtn');

const uploaderBlock = document.getElementById('uploaderBlock');
const modeSelectUpload = document.getElementById('modeSelectUpload');

// Helpers
function resetApp() {
  state.quiz = null;
  state.currentIndex = 0;
  state.answers = new Map();
  state.started = false;
  startBtn.disabled = true;
  quizMeta.classList.add('hidden');
  quizSection.classList.add('hidden');
  resultsSection.classList.add('hidden');
  setError('');
}

function setError(message) {
  if (!message) {
    loadError.textContent = '';
    loadError.classList.add('hidden');
    return;
  }
  loadError.textContent = message;
  loadError.classList.remove('hidden');
}

function isCsvFile(name) { return /\.csv$/i.test(name); }
function isJsonFile(name) { return /\.json$/i.test(name); }
function isMdFile(name) { return /\.md$/i.test(name); }

function parseCsv(text) {
  // Simple CSV: question,options,correct  where options separated by ; and correct indexes 1-based separated by ;
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error('Пустой CSV файл');
  const header = splitCsvLine(lines[0]).map(s => s.trim().toLowerCase());
  const qIdx = header.indexOf('question');
  const oIdx = header.indexOf('options');
  const cIdx = header.indexOf('correct');
  if (qIdx === -1 || oIdx === -1 || cIdx === -1) {
    throw new Error('В CSV должны быть колонки: question, options, correct');
  }
  const questions = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = splitCsvLine(lines[i]);
    if (!raw.length || raw.every(x => (x ?? '').trim() === '')) continue;
    const textCell = raw[qIdx] ?? '';
    const optionsCell = raw[oIdx] ?? '';
    const correctCell = raw[cIdx] ?? '';
    const options = String(optionsCell).split(';').map(s => s.trim()).filter(Boolean);
    const correct = String(correctCell)
      .split(';')
      .map(s => s.trim())
      .filter(Boolean)
      .map(x => Number(x) - 1)
      .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < options.length);
    if (!textCell || options.length === 0 || correct.length === 0) continue;
    questions.push({ id: i, text: textCell, options, correct });
  }
  if (questions.length === 0) throw new Error('Не удалось прочитать ни одного вопроса из CSV');
  return { title: 'Тест из CSV', questions };
}

function splitCsvLine(line) {
  // Minimal CSV parser supporting commas and quoted fields with commas
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function normalizeJsonQuiz(json) {
  if (!json || !Array.isArray(json.questions)) throw new Error('Некорректный JSON тест');
  const title = typeof json.title === 'string' && json.title.trim() ? json.title.trim() : 'Тест';
  const questions = json.questions.map((q, idx) => {
    const options = Array.isArray(q.options) ? q.options.map(String) : [];
    const correct = Array.isArray(q.correct) ? q.correct.map(Number) : [];
    if (!q.text || options.length === 0 || correct.length === 0) {
      throw new Error(`Вопрос ${idx + 1} имеет некорректные данные`);
    }
    return { id: q.id ?? idx + 1, text: String(q.text), options, correct };
  });
  return { title, questions };
}

function loadFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Ошибка чтения файла'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(file, 'utf-8');
  });
}

async function handleFiles(files) {
  resetApp();
  if (!files || files.length === 0) return;
  const file = files[0];
  try {
    const content = await loadFile(file);
    let quiz;
    if (isMdFile(file.name)) {
      quiz = parseDevOpsMarkdownToQuiz(content);
      if (!quiz || !quiz.questions || quiz.questions.length === 0) {
        throw new Error('Не удалось извлечь вопросы из Markdown');
      }
    } else if (isCsvFile(file.name)) {
      quiz = parseCsv(content);
    } else if (isJsonFile(file.name)) {
      const raw = JSON.parse(content);
      quiz = normalizeJsonQuiz(raw);
    } else {
      // попытка авто-определения формата по содержимому
      try {
        const raw = JSON.parse(content);
        quiz = normalizeJsonQuiz(raw);
      } catch (_) {
        const mdQuiz = parseDevOpsMarkdownToQuiz(content);
        if (mdQuiz && mdQuiz.questions && mdQuiz.questions.length > 0) quiz = mdQuiz;
        else quiz = parseCsv(content);
      }
    }
    // применим режим для загружаемого теста
    if (modeSelectUpload && modeSelectUpload.value === 'random40') {
      const picked = pickRandom(quiz.questions, 40);
      quiz = { title: `${quiz.title} — 40 случайных вопросов`, questions: picked };
    } else {
      quiz = { title: `${quiz.title} — Марафон`, questions: quiz.questions };
    }
    state.quiz = quiz;
    startBtn.disabled = false;
    quizMeta.textContent = `${quiz.title} • Вопросов: ${quiz.questions.length}`;
    quizMeta.classList.remove('hidden');
  } catch (e) {
    setError(e.message || 'Не удалось загрузить файл');
  }
}

function renderQuestion(index) {
  const q = state.quiz.questions[index];
  const total = state.quiz.questions.length;
  quizTitle.textContent = state.quiz.title;
  progressEl.textContent = `Вопрос ${index + 1} из ${total}`;

  const userSet = state.answers.get(index) || new Set();
  const isMultiple = q.correct.length > 1;

  const wrapper = document.createElement('div');
  wrapper.className = 'question';
  const title = document.createElement('div');
  title.className = 'question-title';
  title.textContent = q.text + (isMultiple ? ' (несколько вариантов)' : '');
  wrapper.appendChild(title);

  const optionsEl = document.createElement('div');
  optionsEl.className = 'options';
  // helper: мгновенная обратная связь
  const updateFeedback = () => {
    const labels = optionsEl.querySelectorAll('label.option');
    labels.forEach((labelEl, idx) => {
      const selected = (state.answers.get(index) || new Set()).has(idx);
      labelEl.classList.remove('correct', 'incorrect', 'wrong');
      if (selected) {
        if (q.correct.includes(idx)) labelEl.classList.add('correct');
        else labelEl.classList.add('incorrect');
      }
    });
  };
  q.options.forEach((opt, optIdx) => {
    const label = document.createElement('label');
    label.className = 'option';
    const input = document.createElement('input');
    input.type = isMultiple ? 'checkbox' : 'radio';
    input.name = `q_${index}`;
    input.value = String(optIdx);
    input.checked = userSet.has(optIdx);
    input.addEventListener('change', () => {
      const set = state.answers.get(index) || new Set();
      if (isMultiple) {
        if (input.checked) set.add(optIdx); else set.delete(optIdx);
      } else {
        set.clear();
        if (input.checked) set.add(optIdx);
      }
      state.answers.set(index, set);
      updateNavButtons();
      // мгновенная обратная связь на выбранном варианте
      updateFeedback();
    });
    const span = document.createElement('span');
    span.textContent = opt;
    label.appendChild(input);
    label.appendChild(span);
    optionsEl.appendChild(label);
  });
  wrapper.appendChild(optionsEl);

  questionContainer.innerHTML = '';
  questionContainer.appendChild(wrapper);
  // первичная отрисовка обратной связи (если есть сохранённые ответы)
  updateFeedback();
}

function updateNavButtons() {
  const total = state.quiz.questions.length;
  prevBtn.disabled = state.currentIndex === 0;
  const isLast = state.currentIndex === total - 1;
  nextBtn.classList.toggle('hidden', isLast);
  submitBtn.classList.toggle('hidden', !isLast);
}

function startQuiz() {
  if (!state.quiz) return;
  // Применим выбранный режим непосредственно перед стартом
  try {
    if (sourceDevops && sourceDevops.checked && modeSelect) {
      if (modeSelect.value === 'random40') {
        const picked = pickRandom(state.quiz.questions, 40);
        state.quiz = { title: `${state.quiz.title.replace(/\s—.*$/, '')} — 40 случайных вопросов`, questions: picked };
      } else {
        state.quiz = { title: `${state.quiz.title.replace(/\s—.*$/, '')} — Марафон`, questions: state.quiz.questions.map((q, idx) => ({ ...q, id: idx + 1 })) };
      }
      quizMeta.textContent = `${state.quiz.title} • Вопросов: ${state.quiz.questions.length}`;
    }
    if (sourceUpload && sourceUpload.checked && modeSelectUpload) {
      if (modeSelectUpload.value === 'random40') {
        const picked = pickRandom(state.quiz.questions, 40);
        state.quiz = { title: `${state.quiz.title.replace(/\s—.*$/, '')} — 40 случайных вопросов`, questions: picked };
      } else {
        state.quiz = { title: `${state.quiz.title.replace(/\s—.*$/, '')} — Марафон`, questions: state.quiz.questions.map((q, idx) => ({ ...q, id: idx + 1 })) };
      }
      quizMeta.textContent = `${state.quiz.title} • Вопросов: ${state.quiz.questions.length}`;
    }
  } catch (_) {}

  state.started = true;
  document.getElementById('upload-section').classList.add('hidden');
  quizSection.classList.remove('hidden');
  state.currentIndex = 0;
  renderQuestion(state.currentIndex);
  updateNavButtons();
}

function go(delta) {
  const nextIndex = state.currentIndex + delta;
  if (nextIndex < 0 || nextIndex >= state.quiz.questions.length) return;
  state.currentIndex = nextIndex;
  renderQuestion(state.currentIndex);
  updateNavButtons();
}

function computeResults() {
  const details = [];
  let correctCount = 0;
  state.quiz.questions.forEach((q, idx) => {
    const right = new Set(q.correct);
    const picked = state.answers.get(idx) || new Set();
    const isCorrect = right.size === picked.size && [...right].every(x => picked.has(x));
    if (isCorrect) correctCount++;
    details.push({ q, picked: [...picked], isCorrect });
  });
  return { correctCount, total: state.quiz.questions.length, details };
}

function showResults() {
  const { correctCount, total, details } = computeResults();
  quizSection.classList.add('hidden');
  resultsSection.classList.remove('hidden');
  const percent = Math.round((correctCount / total) * 100);
  const incorrectCount = total - correctCount;
  const incorrectPercent = Math.round((incorrectCount / total) * 100);
  resultsSummary.innerHTML = `
    <div>Верных ответов: <strong>${correctCount}</strong> из ${total} (${percent}%)</div>
    <div>Неверных ответов: <strong>${incorrectCount}</strong> из ${total} (${incorrectPercent}%)</div>
  `;

  resultsDetails.innerHTML = '';
  details.forEach((item, idx) => {
    const div = document.createElement('div');
    div.className = 'result-item';
    const title = document.createElement('div');
    title.className = 'question-title';
    title.textContent = `${idx + 1}. ${item.q.text}`;
    const your = document.createElement('div');
    your.className = 'your';
    const correct = document.createElement('div');
    correct.className = 'correct';
    const yourText = item.picked.length ? item.picked.map(i => item.q.options[i]).join('; ') : 'нет ответа';
    const correctText = item.q.correct.map(i => item.q.options[i]).join('; ');
    your.textContent = `Ваш ответ: ${yourText}`;
    correct.textContent = `Правильный ответ: ${correctText}`;
    div.appendChild(title);
    div.appendChild(your);
    div.appendChild(correct);
    resultsDetails.appendChild(div);
  });
}

function downloadCsvReport() {
  const { correctCount, total, details } = computeResults();
  const rows = [];
  rows.push(['#', 'Вопрос', 'Ваш ответ', 'Правильный ответ', 'Верно?']);
  details.forEach((d, idx) => {
    const yourText = d.picked.length ? d.picked.map(i => d.q.options[i]).join(' | ') : 'нет ответа';
    const correctText = d.q.correct.map(i => d.q.options[i]).join(' | ');
    rows.push([String(idx + 1), escapeCsv(d.q.text), escapeCsv(yourText), escapeCsv(correctText), d.isCorrect ? 'Да' : 'Нет']);
  });
  rows.push([]);
  rows.push(['Итого', `${correctCount}/${total}`]);
  const csv = rows.map(r => r.map(cell => maybeQuote(cell)).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'quiz-report.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function maybeQuote(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function escapeCsv(s) { return String(s).replace(/\r?\n/g, ' '); }

// Event wiring
fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length) {
    handleFiles(e.target.files);
    try {
      const name = e.target.files[0].name;
      if (pickFileBtn && name) {
        pickFileBtn.textContent = name;
        pickFileBtn.title = name;
      }
    } catch (_) {}
  }
});

if (pickFileBtn) pickFileBtn.addEventListener('click', () => fileInput.click());
dropZone && dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag');
  const files = e.dataTransfer?.files;
  if (files && files.length) handleFiles(files);
});

startBtn.addEventListener('click', () => startQuiz());
prevBtn.addEventListener('click', () => go(-1));
nextBtn.addEventListener('click', () => go(1));
submitBtn.addEventListener('click', () => showResults());
restartBtn.addEventListener('click', () => {
  state.currentIndex = 0;
  state.answers = new Map();
  resultsSection.classList.add('hidden');
  document.getElementById('upload-section').classList.add('hidden');
  quizSection.classList.remove('hidden');
  renderQuestion(0);
  updateNavButtons();
});
downloadReportBtn.addEventListener('click', () => downloadCsvReport());
downloadJsonBtn.addEventListener('click', () => {
  try {
    // если уже есть загруженный/сгенерированный тест — выгружаем его
    if (state.quiz && state.quiz.questions && state.quiz.questions.length) {
      const blob = new Blob([JSON.stringify(state.quiz, null, 2)], { type: 'application/json;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'devops.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return;
    }
  } catch (_) {}
  // fallback: попробовать загрузить и конвертировать локальный Markdown, если доступен
  tryAutoloadDevOps().then(() => {
    if (state.quiz) {
      const blob = new Blob([JSON.stringify(state.quiz, null, 2)], { type: 'application/json;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'devops.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else {
      alert('Не удалось сформировать devops.json');
    }
  });
});

// ---- DevOps Markdown support ----
function parseDevOpsMarkdownToQuiz(md) {
  const lines = md.split(/\r?\n/);
  const questions = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const text = current.text.trim();
    let options = current.options.map(s => normalizeWhitespace(s)).filter(Boolean);
    const answersText = current.answersText;
    let correct = [];

    if (options.length > 0 && answersText.length > 0) {
      const norm = (s) => normalizeWhitespace(s).toLowerCase();
      const optNorm = options.map(o => norm(o));
      answersText.forEach(ans => {
        const a = norm(ans);
        let idx = optNorm.findIndex(o => o === a);
        if (idx === -1) idx = optNorm.findIndex(o => o.includes(a) || a.includes(o));
        if (idx !== -1 && !correct.includes(idx)) correct.push(idx);
      });
    }

    if (options.length === 0) {
      const correctText = answersText[0] ? normalizeWhitespace(answersText[0]) : 'Правильный ответ';
      const distractors = generateDistractors(correctText);
      options = shuffleArray([correctText, ...distractors]);
      correct = [options.findIndex(o => o === correctText)];
    } else if (correct.length === 0 && answersText.length > 0) {
      const correctText = normalizeWhitespace(answersText[0]);
      if (!options.some(o => normalizeWhitespace(o) === correctText)) {
        options.push(correctText);
        correct = [options.length - 1];
      } else {
        const idx = options.findIndex(o => normalizeWhitespace(o) === correctText);
        correct = [idx >= 0 ? idx : 0];
      }
    }

    if (text && options.length > 0 && correct.length > 0) {
      questions.push({ id: questions.length + 1, text, options, correct });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const qMatch = line.match(/^\*\*(\d+)\.\s*(.+?)\*\*\s*$/);
    if (qMatch) {
      flush();
      current = { text: qMatch[2], options: [], answersText: [] };
      continue;
    }
    if (!current) continue;
    const optMatch = line.match(/^\*\s{1,}(.*)$/);
    if (optMatch) {
      const opt = optMatch[1].trim();
      if (opt && !opt.toLowerCase().startsWith('—')) current.options.push(opt);
      continue;
    }
    const ansMatch = line.match(/^\*\*Ответ:\*\*\s*(.*)$/);
    if (ansMatch) {
      const raw = ansMatch[1].trim();
      const cleaned = raw.replace(/`/g, '').replace(/[()]/g, '');
      const parts = cleaned.split(/\s*(?:,|;|\s+и\s+)\s*/i).map(s => s.trim()).filter(Boolean);
      current.answersText.push(...parts);
      continue;
    }
  }
  flush();

  const title = 'Тест по основам DevOps';
  return { title, questions };
}

function normalizeWhitespace(s) { return String(s).replace(/\s+/g, ' ').trim(); }

function generateDistractors(correctText) {
  const base = [
    'Неверный вариант',
    'Другое определение',
    'Не подходит'
  ];
  const set = new Set(base.filter(b => normalizeWhitespace(b).toLowerCase() !== normalizeWhitespace(correctText).toLowerCase()));
  while (set.size < 3) set.add('Вариант ответа');
  return Array.from(set).slice(0, 3);
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRandom(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length)).map((q, idx) => ({ ...q, id: idx + 1 }));
}

// без встроенного источника — всё через загрузку файла

// Init and autoload
resetApp();

// Автозагрузка отключена (убрана функция встроенного теста)
async function tryAutoloadDevOps() {
  // ничего не делаем
}

tryAutoloadDevOps();
