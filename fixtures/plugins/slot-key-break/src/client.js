export const inject = ['@deepseek-ai/dsh-client-ui-slots']

export function apply(ctx) {
  ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'fixture-slot-key-break',
    order: 30,
  }, function MissingKeyCard() { return null })
}
