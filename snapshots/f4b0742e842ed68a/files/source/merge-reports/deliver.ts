import { z } from 'zod'
import { repositoryOf, type GitHubClient } from '../github/client.ts'
import type { ReportChannel } from './channels.ts'
import type { ReportPayload } from './parse.ts'

/**
 * Deliver one report: an issue over REST, or a discussion over GraphQL, which
 * has no REST endpoint for creating one.
 * @param github - a client holding the channel's token.
 * @param channel - where and how.
 * @param payload - the title and body.
 * @returns the URL of what was created.
 */
export async function deliver(github: GitHubClient, channel: ReportChannel, payload: ReportPayload): Promise<string> {
  if (channel.method === 'issue') {
    const created = await github.rest('POST', `/repos/${channel.repo}/issues`, z.object({ html_url: z.string() }), {
      title: payload.title,
      body: payload.body,
      ...(channel.labels.length === 0 ? {} : { labels: channel.labels }),
    })
    return created.html_url
  }
  const { owner, name } = repositoryOf(channel.repo)
  const found = await github.graphql(
    'query ($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id discussionCategories(first: 50) { nodes { id slug } } } }',
    { owner, name },
    z.object({
      repository: z.object({ id: z.string(), discussionCategories: z.object({ nodes: z.array(z.object({ id: z.string(), slug: z.string() })) }) }),
    }),
  )
  const categories = found.repository.discussionCategories.nodes
  const category = categories.find(node => node.slug === channel.discussionCategory)
  if (category === undefined) {
    throw new Error(`no discussion category \`${channel.discussionCategory}\` in ${channel.repo} (available: ${categories.map(node => node.slug).join(', ')})`)
  }
  const created = await github.graphql(
    'mutation ($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) { createDiscussion(input: { repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body }) { discussion { url } } }',
    { repositoryId: found.repository.id, categoryId: category.id, title: payload.title, body: payload.body },
    z.object({ createDiscussion: z.object({ discussion: z.object({ url: z.string() }) }) }),
  )
  return created.createDiscussion.discussion.url
}
