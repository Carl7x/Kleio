/** Restrict the pinned Harness to this execution's product capabilities. */
export const name = 'kleio-product-tool-boundary';
export const inject = ['tools', 'agents'];

export function apply(ctx, config) {
  const allowed = new Set(config.allowedTools);
  ctx.tools.guard(exec => allowed.has(exec.name) ? undefined : 'Tool is outside the product execution capability set.');
  ctx.on('agent/created', ({ agent }) => {
    // MCP registrations belong to this agent; all inherited tools are hidden.
    agent.ctx.tools.restrict({ allow: [] });
    const names = agent.ctx.tools.schemas(agent).map(tool => tool.name);
    if (names.length !== allowed.size || names.some(name => !allowed.has(name))) {
      throw new Error('The Harness tool catalog does not match the product capability set.');
    }
  });
}
