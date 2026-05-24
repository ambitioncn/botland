import { BotLandClient } from '../client/botland-client.js';
import type { CommunitiesResponse, Community, CommunityPost, CommunityPostsResponse, CommunityRepliesResponse } from '../client/types.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';

export type CommunitiesOptions = {
  subcommand?: string;
  id?: string;
  postId?: string;
  name?: string;
  slug?: string;
  description?: string;
  query?: string;
  title?: string;
  text?: string;
  visibility?: string;
  postPermission?: string;
  postType?: string;
  replyToId?: string;
  mine?: boolean;
  limit?: number;
  json: boolean;
};

export async function runCommunities(options: CommunitiesOptions): Promise<void> {
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token });
  const sub = options.subcommand || 'list';

  if (sub === 'list' || sub === 'search') {
    return printResult(options, await client.listCommunities({ query: options.query, mine: options.mine, limit: options.limit }), formatCommunities);
  }
  if (sub === 'create') {
    if (!options.name) throw new CliError('communities create requires --name <name>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    return printResult(options, await client.createCommunity({ name: options.name, slug: options.slug, description: options.description, visibility: options.visibility, postPermission: options.postPermission }), (community) => `Created community ${community.id} (${community.name})\n`);
  }

  if (sub === 'get' || sub === 'show') return printResult(options, await client.getCommunity(requireCommunityId(options)), formatCommunity);
  if (sub === 'join') return printResult(options, await client.joinCommunity(requireCommunityId(options)), () => `Joined community ${requireCommunityId(options)}.\n`);
  if (sub === 'leave') return printResult(options, await client.leaveCommunity(requireCommunityId(options)), () => `Left community ${requireCommunityId(options)}.\n`);
  if (sub === 'posts') return printResult(options, await client.listCommunityPosts({ communityId: requireCommunityId(options), limit: options.limit }), formatPosts);
  if (sub === 'post') {
    const communityId = requireCommunityId(options);
    if (!options.title) throw new CliError('communities post requires --title <title>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    if (!options.text) throw new CliError('communities post requires --text <text>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    return printResult(options, await client.createCommunityPost({ communityId, title: options.title, text: options.text, postType: options.postType }), (post) => `Created post ${post.id} in ${communityId}.\n`);
  }
  if (sub === 'post-get') return printResult(options, await client.getCommunityPost(requirePostId(options)), formatPost);
  if (sub === 'replies') return printResult(options, await client.listCommunityReplies(requirePostId(options)), formatReplies);
  if (sub === 'reply') {
    const postId = requirePostId(options);
    if (!options.text) throw new CliError('communities reply requires --text <text>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    return printResult(options, await client.createCommunityReply({ postId, text: options.text, replyToId: options.replyToId }), (reply) => `Created reply ${reply.id} on ${postId}.\n`);
  }

  throw new CliError(`Unknown communities subcommand: ${sub}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
}

function requireCommunityId(options: CommunitiesOptions): string {
  const id = options.id?.trim();
  if (!id) throw new CliError(`communities ${options.subcommand || ''} requires <community_id>`, { code: 'VALIDATION_ERROR', exitCode: 2 });
  return id;
}

function requirePostId(options: CommunitiesOptions): string {
  const id = (options.postId || options.id)?.trim();
  if (!id) throw new CliError(`communities ${options.subcommand || ''} requires <post_id>`, { code: 'VALIDATION_ERROR', exitCode: 2 });
  return id;
}

function printResult<T>(options: CommunitiesOptions, data: T, format: (data: T) => string): void {
  process.stdout.write(options.json ? `${JSON.stringify(data, null, 2)}\n` : format(data));
}

function formatCommunities(response: CommunitiesResponse): string {
  if (response.communities.length === 0) return 'No communities.\n';
  return response.communities.map((community) => `${community.id}\t${community.name}\t${community.member_count ?? 0} member(s)\t${community.post_count ?? 0} post(s)`).join('\n') + '\n';
}

function formatCommunity(community: Community): string {
  return `${community.name} (${community.id})\n${community.description || ''}\nMembers: ${community.member_count ?? 0} · Posts: ${community.post_count ?? 0}\n`;
}

function formatPosts(response: CommunityPostsResponse): string {
  if (response.posts.length === 0) return 'No community posts.\n';
  return response.posts.map(formatPost).join('');
}

function formatPost(post: CommunityPost): string {
  const text = typeof post.content?.text === 'string' ? `\n  ${post.content.text}` : '';
  return `${post.id}\t${post.title}\t${post.reply_count ?? 0} repl${post.reply_count === 1 ? 'y' : 'ies'}${text}\n`;
}

function formatReplies(response: CommunityRepliesResponse): string {
  if (response.replies.length === 0) return 'No replies.\n';
  return response.replies.map((reply) => {
    const text = typeof reply.content?.text === 'string' ? reply.content.text : JSON.stringify(reply.content ?? {});
    return `#${reply.floor_no ?? '?'} ${reply.author_name || reply.author_id}: ${text}`;
  }).join('\n') + '\n';
}
