/* Native, fixed-scale F1 charts. Charts and tables share the audited paper data. */
(() => {
  'use strict';
  const root = document.querySelector('#results');
  if (!root) return;
  const data = window.PROMANO_QUANTITATIVE;
  const status = document.querySelector('#quant-status');
  if (!data) { status.classList.remove('sr-only'); status.textContent = 'Result data could not load. Reload the page to try again.'; return; }
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const number = value => value.toFixed(2);
  const gain = value => (value >= 0 ? '+' : '−') + Math.abs(value).toFixed(2);
  const isScore = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
  const valueLabel = value => isScore(value) ? number(value) : value === 'failure' ? '×' : '—';
  const statusLabel = value => value === 'failure' ? 'at least one tracking failure; no dataset mean reported' : 'not reported';
  let group = 'all', datasetIndex = 0;

  try {
    for (const method of data.methods) {
      if (method.values.length !== data.datasets.length || method.values.some(v => !isScore(v) && !['failure', 'unreported'].includes(v))) throw Error('Invalid benchmark data');
    }
    for (const predictor of data.predictors) {
      if (predictor.pairs.length !== data.datasets.length || predictor.pairs.some(pair => pair.length !== 2 || pair.some(v => !isScore(v)))) throw Error('Invalid predictor data');
    }
  } catch {
    status.classList.remove('sr-only');
    status.textContent = 'The result data could not be displayed. Reload the page to try again.';
    return;
  }

  function axis() {
    const node = make('div', 'quant-axis');
    node.setAttribute('aria-hidden', 'true');
    for (const tick of [0, 25, 50, 75, 100]) node.append(make('span', '', String(tick)));
    return node;
  }

  function barRow(name, value, kind, tag = 'li') {
    const row = make(tag, 'quant-bar-row kind-' + kind + (isScore(value) ? '' : ' is-status'));
    const label = name + ': ' + (isScore(value) ? number(value) + '% mean F₁' : statusLabel(value));
    row.setAttribute('aria-label', label);
    row.title = label;
    const method = make('span', 'quant-method', name);
    const track = make('span', 'quant-bar-track');
    track.setAttribute('aria-hidden', 'true');
    if (isScore(value)) {
      const fill = make('span', 'quant-bar-fill');
      fill.style.width = value + '%';
      track.append(fill);
    }
    const score = make('span', 'quant-value', valueLabel(value));
    method.setAttribute('aria-hidden', 'true'); score.setAttribute('aria-hidden', 'true');
    row.append(method, track, score);
    return row;
  }

  function tableBase(captionText, headings) {
    const table = make('table', 'quant-table');
    table.append(make('caption', '', captionText));
    const head = make('thead'), row = make('tr');
    for (const label of headings) {
      const th = make('th', '', label); th.scope = 'col'; row.append(th);
    }
    head.append(row); table.append(head);
    const body = make('tbody'); table.append(body);
    return {table, body};
  }

  function renderBenchmark() {
    const methods = data.methods.filter(method => group === 'all' || method.group !== 'prior');
    const cards = document.createDocumentFragment();
    data.datasets.forEach((dataset, index) => {
      const figure = make('figure', 'quant-card');
      figure.setAttribute('aria-labelledby', 'quant-dataset-' + dataset.id);
      const header = make('header'), title = make('h3', '', dataset.name);
      title.id = 'quant-dataset-' + dataset.id;
      header.append(title, make('p', 'quant-meta', `${dataset.sequences} sequences · F₁ @ ${dataset.thresholdCm} cm`));
      const bars = make('ul', 'quant-bars');
      bars.setAttribute('aria-label', dataset.name + ' mean reconstruction F₁, percent. Higher is better.');
      for (const method of methods) bars.append(barRow(method.name, method.values[index], method.group));
      figure.append(header, make('p', 'quant-unit', 'Mean F₁ (%) · higher is better'), bars, axis(), make('figcaption', 'quant-card-note', 'Reported Avg. · ' + dataset.sourceTable));
      cards.append(figure);
    });
    document.querySelector('#quant-benchmarks').replaceChildren(cards);
    for (const button of root.querySelectorAll('[data-quant-group]')) button.setAttribute('aria-pressed', String(button.dataset.quantGroup === group));
    document.querySelector('#quant-comparison-note').textContent = group === 'all'
      ? 'Paper-reported dataset means. Our three mapping variants use DA3-Nested with the same visual–inertial frontend trajectory.'
      : 'Controlled backend comparison: the same DA3-Nested predictor and visual–inertial frontend trajectory, with only the mapping backend changed.';
    const {table, body} = tableBase('Mean reconstruction F₁ (%) · ' + data.sources.benchmark + ' · values for the displayed methods', ['Method', ...data.datasets.map(d => d.name)]);
    for (const method of methods) {
      const tr = make('tr', method.group === 'ours' ? 'quant-row-ours' : '');
      const th = make('th', '', method.name); th.scope = 'row'; tr.append(th);
      for (const value of method.values) {
        const cell = make('td', '', valueLabel(value));
        if (!isScore(value)) { cell.title = statusLabel(value); cell.setAttribute('aria-label', statusLabel(value)); }
        tr.append(cell);
      }
      body.append(tr);
    }
    document.querySelector('#quant-benchmark-table').replaceChildren(table);
  }

  function renderPredictors() {
    const dataset = data.datasets[datasetIndex], rows = document.createDocumentFragment();
    for (const predictor of data.predictors) {
      const [sim3, ours] = predictor.pairs[datasetIndex], delta = ours - sim3;
      const row = make('article', 'predictor-row');
      const header = make('header');
      header.append(make('h4', '', predictor.name), make('span', 'quant-gain', gain(delta) + ' pp'));
      const list = make('ul', 'quant-bars');
      list.setAttribute('aria-label', predictor.name + ' on ' + dataset.name);
      list.append(barRow('Ours w/ Sim(3)', sim3, 'sim3'), barRow('ProManO', ours, 'ours'));
      row.append(header, list); rows.append(row);
    }
    rows.append(axis());
    document.querySelector('#quant-predictors').replaceChildren(rows);
    for (const button of root.querySelectorAll('[data-quant-dataset]')) button.setAttribute('aria-pressed', String(button.dataset.quantDataset === dataset.id));
    document.querySelector('#quant-dataset-caption').textContent = `${dataset.name} · mean F₁ (%) @ ${dataset.thresholdCm} cm · higher is better`;
    const {table, body} = tableBase(dataset.name + ' · reported mean F₁ (%) · ' + data.sources.predictors, ['Feed-forward model', 'Ours w/ Sim(3)', 'ProManO', 'Gain (pp)']);
    for (const predictor of data.predictors) {
      const [sim3, ours] = predictor.pairs[datasetIndex], tr = make('tr');
      const th = make('th', '', predictor.name); th.scope = 'row';
      tr.append(th, make('td', '', number(sim3)), make('td', 'quant-cell-ours', number(ours)), make('td', 'quant-cell-gain', gain(ours - sim3)));
      body.append(tr);
    }
    document.querySelector('#quant-predictor-table').replaceChildren(table);
  }

  const ours = data.methods.find(method => method.group === 'ours');
  const wins = data.datasets.filter((_, i) => ours.values[i] > Math.max(...data.methods.filter(m => m !== ours && isScore(m.values[i])).map(m => m.values[i]))).length;
  const deltas = data.predictors.flatMap(p => p.pairs.map(([sim3, corrected]) => corrected - sim3));
  const highlights = [
    [wins + '/' + data.datasets.length, 'datasets', 'Highest reported mean F₁ among the evaluated methods.'],
    [deltas.filter(d => d > 0).length + '/' + deltas.length, 'paired improvements', 'ProManO improves mean F₁ across all four predictors and four datasets.'],
    ['+' + number(Math.min(...deltas)) + '–' + number(Math.max(...deltas)), 'percentage points', 'Range of F₁ gains over the same-predictor Sim(3) variant in Table 4.']
  ];
  const summary = document.createDocumentFragment();
  for (const [value, label, note] of highlights) {
    const article = make('article'); article.append(make('strong', '', value), make('span', '', label), make('p', '', note)); summary.append(article);
  }
  document.querySelector('#quant-highlights').replaceChildren(summary);

  for (const button of root.querySelectorAll('[data-quant-group]')) button.addEventListener('click', () => {
    group = button.dataset.quantGroup; renderBenchmark();
    status.textContent = group === 'all' ? 'Showing all ten reported methods on four datasets.' : 'Showing the three mapping variants with the same frontend and predictor.';
  });
  for (const button of root.querySelectorAll('[data-quant-dataset]')) button.addEventListener('click', () => {
    datasetIndex = data.datasets.findIndex(d => d.id === button.dataset.quantDataset); renderPredictors();
    status.textContent = 'Showing four predictor comparisons on ' + data.datasets[datasetIndex].name + '.';
  });
  renderBenchmark(); renderPredictors(); status.textContent = '';
})();
