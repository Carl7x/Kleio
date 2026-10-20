import type { WorkNotification } from '../../packages/personal-tasks/runtime.ts';

/** Display-only copy. Persisted delivery and read-state ownership stay with WorkRuntime. */
export function projectNotification(value: Readonly<WorkNotification>, redact: (text: string) => string): WorkNotification {
  return { ...value, title: redact(value.title), text: redact(value.text) };
}
