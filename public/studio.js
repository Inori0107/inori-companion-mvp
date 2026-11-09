import { $, api, bindForm, button, download, node, option, requestId, useAccount } from './client.js';

let studio;
let selectedRun;
let running = false;
let stop = false;
const dimensions = ['trust', 'familiarity', 'mood', 'energy', 'comfort'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fillSelect(id, items, preferred) {
  const select = $(id);
  const prior = select.value;
  select.replaceChildren(...items.map(item => Array.isArray(item) ? option(...item) : option(item)));
  if (preferred !== undefined && items.some(item => (Array.isArray(item) ? item[1] : item) === preferred)) select.value = preferred;
  else if ([...select.options].some(item => item.value === prior)) select.value = prior;
}

function selectPersona() {
  const persona = studio.personas.find(row => row.config.version === $('versions').value);
  if (!persona) return;
  $('config').value = JSON.stringify(persona.config, null, 2);
  $('examples').value = JSON.stringify(persona.examples, null, 2);
}

function selectCase() {
  const test = studio.cases.find(row => row.id === $('case').value);
  $('syntheticFields').hidden = !!test;
  $('caseDetails').textContent = test ? [test.input, test.context, '預期 ' + test.expected_behavior, '避免 ' + test.forbidden_behavior].filter(Boolean).join(' · ') : '';
}

function renderStudio() {
  const versions = studio.personas.map(p => p.config.version);
  $('active').textContent = '已啟用 ' + studio.active;
  $('canonSource').href = studio.source;
  for (const key of ['versions', 'versionA', 'reportVersion']) fillSelect(key, versions);
  fillSelect('versionB', [['不比較', ''], ...versions]);
  for (const key of ['modelA', 'modelB']) fillSelect(key, studio.models, $(key).value || 'mock');
  fillSelect('reportModel', [...new Set([...studio.models, ...studio.runs.map(run => run.model)])], $('reportModel').value || 'mock');
  fillSelect('case', [['自訂合成情境', ''], ...studio.cases.map(row => [row.id + ' · ' + row.input, row.id])], $('case').value || 'P01');
  $('tags').replaceChildren(...studio.feedbackTags.map(tag => option(tag)));
  selectPersona();
  selectCase();
  renderReport();
}

function card(run, editable) {
  const article = node('article');
  article.append(
    node('h3', (run.caseId || '自訂') + ' · ' + run.model),
    node('p', run.version + ' · ' + new Date(run.at).toLocaleString('zh-TW'), 'hint'),
    node('p', run.input), node('pre', run.reply),
    node('p', run.check + ' · ' + (run.score === null ? '未評分' : run.score + ' / 5'), 'hint'),
  );
  if (editable) {
    if (run.tags.length || run.notes) article.append(node('p', [...run.tags, run.notes].filter(Boolean).join(' · '), 'hint'));
    article.append(button('人工評分', () => openRating(run)), button('刪除', async () => {
      if (!confirm('刪除這筆合成評測？')) return;
      try { merge(await api('studio', { action: 'deleteRun', id: run.id })); renderReport(); }
      catch (error) { $('notice').textContent = error.message; }
    }));
  }
  return article;
}

function renderReport() {
  const runs = studio.runs.filter(run => run.model === $('reportModel').value && run.version === $('reportVersion').value).toReversed();
  const latest = new Map();
  for (const run of runs) {
    if (run.score !== null && run.caseId && !run.caseId.startsWith('H') && !latest.has(run.caseId)) latest.set(run.caseId, run.score);
  }
  const report = $('report');
  report.replaceChildren();
  let total = 0;
  let complete = true;
  for (const { code, label, weight } of studio.weights) {
    const scores = [...latest].filter(([id]) => id.startsWith(code)).map(([, score]) => score);
    const possible = studio.cases.filter(test => test.id.startsWith(code)).length;
    const average = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
    if (average === null) complete = false;
    else total += average * weight / 100;
    report.append(node('p', label + ' · ' + (average === null ? '未評分' : average.toFixed(2) + ' / 5') + ' · ' + scores.length + ' / ' + possible, 'hint'));
  }
  if (complete) report.append(node('p', '加權分數 ' + total.toFixed(2) + ' / 5'));
  $('results').replaceChildren(...runs.map(run => card(run, true)));
}

function merge(update) { studio = { ...studio, ...update }; }

$('versions').onchange = selectPersona;
$('case').onchange = selectCase;
$('reportModel').onchange = renderReport;
$('reportVersion').onchange = renderReport;
$('downloadRuns').onclick = () => download('inori-evaluations.json', studio.runs);

$('activate').onclick = async () => {
  $('activate').disabled = true;
  try {
    merge(await api('studio', { action: 'activate', version: $('versions').value }));
    renderStudio();
  } catch (error) { $('notice').textContent = error.message; }
  finally { $('activate').disabled = false; }
};

bindForm('personaForm', 'personaStatus', async () => {
  merge(await api('studio', { action: 'publish', config: JSON.parse($('config').value),
    examples: JSON.parse($('examples').value), reason: $('reason').value, activate: $('activateNew').checked }));
  renderStudio();
  $('personaStatus').textContent = '版本已建立。';
});

$('stop').onclick = () => { stop = true; };
$('trialForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (running) return;
  const batch = event.submitter?.value === 'suite';
  if (batch && $('modelA').value !== 'mock' && !confirm('確認執行 52 次模型生成？這會計入生成配額。')) return;
  running = true;
  stop = false;
  $('run').disabled = true;
  $('runSuite').disabled = true;
  $('stop').disabled = !batch;
  $('compare').replaceChildren();
  const state = Object.fromEntries(dimensions.map(key => [key, $(key).valueAsNumber]));
  const cases = batch ? studio.cases.map(row => row.id) : [$('case').value];
  const a = { version: $('versionA').value, model: $('modelA').value };
  const b = { version: $('versionB').value, model: $('modelB').value };
  const input = $('trialInput').value;
  const synthetic = $('synthetic').checked;
  let finished = 0;
  try {
    for (const caseId of cases) {
      if (stop) break;
      for (const selection of (!batch && b.version ? [a, b] : [a])) {
        if (finished) await sleep(850);
        $('trialStatus').textContent = '執行中 · ' + (caseId || '自訂') + ' · 已完成 ' + finished;
        const trial = await api('studio-run', { ...selection, id: requestId(), caseId, input, synthetic, state });
        studio.runs.push(trial);
        if (!batch) $('compare').append(card(trial, true));
        finished++;
      }
    }
    $('trialStatus').textContent = (stop ? '批次已停止。' : '測試已完成。') + ' 本次 ' + finished + ' 筆。';
  } catch (error) { $('trialStatus').textContent = error.message + ' 已完成 ' + finished + ' 筆。'; }
  finally {
    renderReport();
    running = false;
    $('run').disabled = false;
    $('runSuite').disabled = false;
    $('stop').disabled = true;
  }
});

function openRating(run) {
  selectedRun = run.id;
  $('rating').value = run.score ?? 5;
  $('notes').value = run.notes;
  for (const option of $('tags').options) option.selected = run.tags.includes(option.value);
  $('rateStatus').textContent = '';
  $('rateDialog').showModal();
}

$('closeRate').onclick = () => $('rateDialog').close();
bindForm('rateForm', 'rateStatus', async () => {
  merge(await api('studio', { action: 'rate', id: selectedRun, score: $('rating').valueAsNumber,
    tags: [...$('tags').selectedOptions].map(option => option.value), suggestion: $('notes').value }));
  $('rateDialog').close();
  renderReport();
});

try {
  studio = await api('studio');
  useAccount(studio.accountId);
  renderStudio();
  $('studio').hidden = false;
} catch (error) { $('notice').textContent = error.message; }
