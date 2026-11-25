'use strict';

for (const slider of document.querySelectorAll('.compare-stage input[type="range"]')) {
  const stage = slider.closest('.compare-stage');
  const setSplit = () => stage.style.setProperty('--split', slider.value + '%');
  setSplit();
  slider.addEventListener('input', setSplit);
}

const detailCards = [...document.querySelectorAll('.detail-card')];
const detailFilters = document.querySelectorAll('[data-detail-filter]');
const scaleRows = document.querySelectorAll('[data-scale-for]');
for (const filter of detailFilters) {
  filter.addEventListener('click', () => {
    const dataset = filter.dataset.detailFilter;
    for (const button of detailFilters) button.setAttribute('aria-pressed', String(button === filter));
    for (const card of detailCards) card.hidden = dataset !== 'all' && card.dataset.dataset !== dataset;
    const environment = dataset === 'CID-SIMS' ? 'indoor' : 'outdoor';
    for (const row of scaleRows) row.hidden = dataset !== 'all' && row.dataset.scaleFor !== environment;
  });
}

const detailMethod = document.querySelector('#detail-method');
const comparisonKey = document.querySelector('#compare-key');
let displayedMethod = 'sim3';
detailMethod.addEventListener('change', async () => {
  const method = detailMethod.value;
  const name = detailMethod.selectedOptions[0].textContent;
  const images = detailCards.map(card => card.querySelector('.compare-base img'));
  try {
    await Promise.all(images.map(image => {
      const preview = new Image();
      preview.src = image.dataset[method];
      return preview.decode();
    }));
  } catch {
    if (detailMethod.value === method) {
      detailMethod.value = displayedMethod;
      comparisonKey.textContent = 'The selected comparison could not load. Try again.';
    }
    return;
  }
  if (detailMethod.value !== method) return;
  for (const image of images) image.src = image.dataset[method];
  for (const card of detailCards) card.querySelector('.baseline-name').textContent = name;
  displayedMethod = method;
  comparisonKey.textContent = 'Left: ' + name + '. Right: ProManO.';
});

const filters = [...document.querySelectorAll('[data-filter]')];
const thumbnails = [...document.querySelectorAll('.scene')];
for (const filter of filters) {
  filter.addEventListener('click', () => {
    for (const item of filters) item.setAttribute('aria-pressed', String(item === filter));
    const dataset = filter.dataset.filter;
    for (const item of thumbnails) item.hidden = dataset !== 'all' && item.dataset.set !== dataset;
  });
}

const lightbox = document.querySelector('#lightbox');
const dialogImage = document.querySelector('#dialog-image');
const dialogCaption = document.querySelector('#dialog-caption');
let activeScene;
for (const item of thumbnails) {
  item.addEventListener('click', event => {
    if (!lightbox.showModal || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    activeScene = item;
    dialogCaption.textContent = item.querySelector('small').textContent + ' · ' + item.querySelector('span').lastChild.textContent;
    dialogImage.src = item.href;
    dialogImage.alt = item.querySelector('img').alt;
    lightbox.showModal();
  });
}
document.querySelector('#close-lightbox').addEventListener('click', () => lightbox.close());
lightbox.addEventListener('click', event => {
  if (event.target !== lightbox) return;
  const box = lightbox.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) lightbox.close();
});
lightbox.addEventListener('close', () => {
  dialogImage.removeAttribute('src');
  if (activeScene) activeScene.focus();
});

const scores = {
  nested: [[49.87,53.99],[40.49,45.24],[50.97,60.74],[24.85,29.09]],
  large: [[43.32,49.60],[33.33,37.23],[48.52,57.83],[22.32,28.68]],
  pi3x: [[49.56,52.67],[40.29,44.11],[59.63,64.32],[25.11,29.69]],
  vggt: [[46.32,48.53],[36.65,40.99],[58.69,62.97],[24.77,28.85]]
};
const predictor = document.querySelector('#predictor');
predictor.addEventListener('change', () => {
  const cohort = scores[predictor.value];
  const rows = document.querySelectorAll('#scores tr');
  cohort.forEach(([similarity, full], index) => {
    const cells = rows[index].querySelectorAll('td');
    cells[0].textContent = similarity.toFixed(2);
    cells[1].textContent = full.toFixed(2);
    cells[2].textContent = '+' + (full - similarity).toFixed(2);
  });
  document.querySelector('#score-note').textContent = 'Table VII · ' + predictor.selectedOptions[0].textContent + ' · Δ in percentage points';
});
