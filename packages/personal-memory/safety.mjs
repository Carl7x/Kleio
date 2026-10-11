/** Safety gates for candidate capture; these reject input, never infer a fact. */
export class PersonalDataError extends Error {
  constructor(code, message) { super(message); this.name = 'PersonalDataError'; this.code = code; }
}
export function boundedText(value, field, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim())) {
    throw new PersonalDataError('INVALID_INPUT', `Invalid ${field}.`);
  }
  return value.trim();
}
export const slotPart = value => value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ').trim();
export function containsSecret(value) {
  return /(?:api[ _-]?key|password|passwd|access[ _-]?token|bearer|private[ _-]?key|密码|口令|密钥|令牌|私钥)/iu.test(value)
    || /\b(?:sk-[A-Za-z0-9_-]{16,}|LTAI[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.)/u.test(value);
}
export function captureSkipReason(value) {
  if (containsSecret(value)) return 'secret';
  if (/(?:验收|虚构|测试资料|测试用户|测试样例|演示资料|假设|假如|举个例子|比方说|例如|示例|synthetic|hypothetical|simulation|test fixture)/iu.test(value)) return 'nonfactual';
  if (/^\s*>|```|<\/?(?:system|assistant|tool)\b/imu.test(value)) return 'quoted_or_code';
  return null;
}
export function requireSafeFact(record) {
  if (containsSecret(`${record.subject || ''}\n${record.key || ''}\n${record.text || ''}`)) {
    throw new PersonalDataError('SECRET_NOT_ALLOWED', 'Do not store credentials in personal memory.');
  }
}
