import { evaluateObservation } from './watch.mjs';
import { demoWatch, observation, scenarios } from './scenarios.mjs';

const ui = Object.fromEntries(['scenario', 'scenario-description', 'result-panel', 'decision-badge', 'decision-title', 'decision-summary', 'decision-detail', 'previous', 'current', 'previous-date', 'current-date', 'read-status', 'ignore-metadata', 'confirm-empty', 'compare', 'next-check', 'reset', 'round-note', 'error', 'changes', 'json-result'].map(name => [name, document.getElementById(name)]));
let selected, saved, sequence, lastResult;
const words = {
  baseline: ['首次观察', '已建立比较基线'],
  unchanged: ['无变化 · 安静', '本次无需打扰'],
  changed: ['有变化 · 建议说明', '把前后变化交给你'],
  attention: ['无法判断 · 需要说明', '没有把失败当成无变化'],
  ignored: ['忽略本轮', '这次结果不再使用'],
};

for (const scenario of scenarios) {
  const option = document.createElement('option'); option.value = scenario.id; option.textContent = scenario.title;
  ui.scenario.append(option);
}

function addChange(label, text) {
  const item = document.createElement('li');
  const tag = document.createElement('span'); tag.className = 'change-label'; tag.textContent = label;
  const body = document.createElement('span'); body.className = 'change-text'; body.textContent = text;
  item.append(tag, body); ui.changes.append(item);
}

function compare() {
  ui.error.textContent = '';
  try {
    // When the demo comparison policy changes, recreate its initial fixture
    // under that policy. Production callers must increment watch.revision.
    const watch = { ...demoWatch, ...selected.watch, ignoreRelativeMetadata: ui['ignore-metadata'].checked };
    if (saved && saved.ignoreRelativeMetadata !== watch.ignoreRelativeMetadata) {
      saved = evaluateObservation({ ...demoWatch, ignoreRelativeMetadata: watch.ignoreRelativeMetadata }, null, observation(1)).nextState;
      sequence = 2;
    }
    const status = ui['read-status'].value;
    const current = observation(sequence, { ...selected.next, status, complete: status === 'ok',
      text: ui.current.value, emptyConfirmed: ui['confirm-empty'].checked });
    lastResult = evaluateObservation(watch, saved, current);
    ui['result-panel'].dataset.tone = lastResult.decision;
    ui['decision-badge'].textContent = words[lastResult.decision][0];
    ui['decision-title'].textContent = words[lastResult.decision][1];
    ui['decision-summary'].textContent = lastResult.summary;
    ui['decision-detail'].textContent = lastResult.shouldNotify
      ? '模块建议给出说明；此演示没有发送任何消息。' : '模块不建议产生新消息；观察状态仍可检查。';
    ui.previous.value = saved?.baseline?.lines.join('\n') ?? '尚无完整观察';
    ui['previous-date'].textContent = saved?.baseline ? `第 ${saved.baseline.sequence} 次完整观察` : '';
    ui['current-date'].textContent = `第 ${sequence} 次检查`;
    ui.changes.replaceChildren();
    for (const line of lastResult.diff.added) addChange('新增', line);
    for (const change of lastResult.diff.updated) addChange('修改', `${change.before}\n→ ${change.after}`);
    for (const line of lastResult.diff.removed) addChange('移除', line);
    for (const change of lastResult.diff.ignoredMetadata) addChange('已忽略', `${change.before}\n→ ${change.after}`);
    if (!ui.changes.childElementCount) addChange('本轮', lastResult.summary);
    ui['json-result'].textContent = JSON.stringify(lastResult, null, 2);
    ui['next-check'].disabled = lastResult.decision === 'ignored';
  } catch (error) {
    lastResult = null;
    ui.error.textContent = error.message;
    ui['next-check'].disabled = true;
  }
}

function loadScenario() {
  selected = scenarios.find(item => item.id === ui.scenario.value) ?? scenarios[0];
  sequence = 2;
  saved = evaluateObservation(demoWatch, null, observation(1)).nextState;
  ui.current.value = selected.next.text ?? (selected.next.status === 'failed' ? '' : observation(2).text);
  ui['read-status'].value = selected.next.status ?? 'ok';
  ui['ignore-metadata'].checked = true;
  ui['confirm-empty'].checked = false;
  ui['scenario-description'].textContent = selected.description;
  ui['round-note'].textContent = '比较不会发出通知。刷新页面后，本页观察记录会重置。';
  compare();
}

ui.scenario.addEventListener('change', loadScenario);
ui.compare.addEventListener('click', compare);
ui.reset.addEventListener('click', loadScenario);
ui['next-check'].addEventListener('click', () => {
  if (!lastResult || lastResult.decision === 'ignored') return;
  saved = lastResult.nextState; sequence++;
  ui['round-note'].textContent = '已在本页沿用返回状态。再次观察相同内容时，不会重复产生变化结果。';
  compare();
});
ui['ignore-metadata'].addEventListener('change', compare);
loadScenario();
