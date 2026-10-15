export const demoWatch = { id: 'photo-course', revision: 1, sourceUrl: 'https://example.org/courses',
  region: '摄影课程公开列表', active: true, ignoreRelativeMetadata: true };

export const baselineText = '摄影入门课 · 线上中文班\n价格：¥1999\n开课日期：2026-11-06\n更新时间：5分钟前';

export function observation(sequence, changes = {}) {
  return { id: `check-${sequence}`, watchId: demoWatch.id, revision: 1, sequence,
    capturedAt: new Date(Date.UTC(2026, 9, 15, 10, sequence)).toISOString(),
    sourceUrl: demoWatch.sourceUrl, region: demoWatch.region, status: 'ok', complete: true,
    text: baselineText, ...changes };
}

export const scenarios = [
  { id: 'quiet', title: '无变化，保持安静', description: '只有行序、空白和独立的更新时间变化。',
    next: { text: '更新时间：10分钟前\n开课日期：2026-11-06\n价格：¥1999\n  摄影入门课   · 线上中文班 ' } },
  { id: 'price', title: '降价，给出前后依据', description: '数字是业务内容；价格变化会被保留。',
    next: { text: baselineText.replace('1999', '1599') } },
  { id: 'deadline', title: '开课改期，要说明', description: '不会把业务日期当成页面时间噪声。',
    next: { text: baselineText.replace('2026-11-06', '2026-11-13') } },
  { id: 'failed', title: '抓取失败，不能静默', description: '保留上一份完整记录，明确本次无法判断。',
    next: { status: 'failed', complete: false, text: undefined } },
  { id: 'partial', title: '只抓到一半，不判删除', description: '缺失内容可能只是读取不完整。',
    next: { status: 'partial', complete: false, text: '摄影入门课 · 线上中文班' } },
  { id: 'empty', title: '空白页面，先标不确定', description: '没有明确确认的空内容不能当作课程下架。', next: { text: '' } },
  { id: 'revision', title: '旧条件结果，不再使用', description: '条件已升级到第 2 版，迟到的第 1 版结果不进入新基线。',
    watch: { revision: 2 }, next: { revision: 1, text: baselineText.replace('1999', '999') } },
  { id: 'paused', title: '已经暂停，忽略结果', description: '暂停后到达的结果不改变观察状态。', watch: { active: false }, next: {} },
];
