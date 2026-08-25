export const inject = ['@deepseek-ai/dsh-client-ui-slots']

export function apply(ctx) {
  ctx.slots.register({
    name: 'conversation.chat.node',
    id: 'assistant-step',
    key: 'assistant-step',
    order: -1,
  }, function FullMarkdownShadow() { return null })
}
