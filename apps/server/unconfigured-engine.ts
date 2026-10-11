import { CoreError, type AgentEngine } from '../../packages/core/contracts.ts';

/** Keep the product usable for configuration without pretending a model is connected. */
export class UnconfiguredEngine implements AgentEngine {
  readonly id = 'dsh-unconfigured';
  readonly capabilities = { cancel: false, permissions: false, resume: false, steer: false };
  constructor(private readonly missing: string[]) {}
  async execute(): Promise<{ text: string }> {
    throw new CoreError('model_not_configured', '模型尚未配置。请在设置中查看接入说明：' + this.missing.join('；'));
  }
  async close(): Promise<void> {}
}
