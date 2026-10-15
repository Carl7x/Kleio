// Adapted from OpenMuse 1ac68f3909f2, apps/server/src/engine/page-diff.ts.
// MIT, Copyright (c) 2026 OpenMuse contributors. See LICENSE.openmuse.
// Changes: retain before/after pairs; never clip compared data; relative-time
// suppression is opt-in and limited to whole, labelled metadata lines.

const englishMetadata = /^(?:posted|updated|published)(?:\s+at|\s*:)?\s+(?:\d+|an?|one)\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago[.!]?$/iu;
const chineseMetadata = /^(?:发布于|更新于|发布时间[:：]?|更新时间[:：]?)\s*(?:\d+|一|两|半)\s*(?:秒|分钟|小时|天|周|个月|年)前[。]?$/u;

export function metadataKey(line) {
  if (englishMetadata.test(line)) return line.replace(/\s+(?:\d+|an?|one)\s+.*$/iu, ' <relative-time>');
  if (chineseMetadata.test(line)) return line.replace(/(?:\d+|一|两|半)\s*(?:秒|分钟|小时|天|周|个月|年)前[。]?$/u, '<relative-time>');
  return line;
}

function pair(previous, current, key) {
  const open = new Map();
  previous.forEach((line, index) => {
    const value = key(line);
    if (!open.has(value)) open.set(value, []);
    open.get(value).push({ line, index });
  });
  const used = new Set();
  const paired = [], unpaired = [];
  for (const line of current) {
    const match = open.get(key(line))?.shift();
    if (!match) unpaired.push(line);
    else { used.add(match.index); paired.push({ before: match.line, after: line }); }
  }
  return { paired, unpaired, left: previous.filter((_, index) => !used.has(index)) };
}

export function diffLines(previous, current, { ignoreRelativeMetadata = false } = {}) {
  const same = pair(previous, current, line => line);
  const metadata = ignoreRelativeMetadata
    ? pair(same.left, same.unpaired, metadataKey)
    : { paired: [], left: same.left, unpaired: same.unpaired };
  // This key only groups a numeric edit as an update; it NEVER makes it silent.
  const numbers = pair(metadata.left, metadata.unpaired, line => line.replace(/\d+(?:[.,]\d+)*/g, '#'));
  return { added: numbers.unpaired, updated: numbers.paired, removed: numbers.left,
    ignoredMetadata: metadata.paired };
}
