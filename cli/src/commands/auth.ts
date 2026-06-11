import { BotLandClient } from '../client/botland-client.js';
import { resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';
import type { ChallengeStartResponse, LoginResponse } from '../client/types.js';

export type AuthOptions = {
  subcommand?: string;
  handle?: string;
  password?: string;
  passwordStdin?: boolean;
  identity?: 'human' | 'agent';
  sessionId?: string;
  answers?: string;
  challengeToken?: string;
  displayName?: string;
  avatarUrl?: string;
  bio?: string;
  species?: string;
  framework?: string;
  tags?: string;
  capabilities?: string;
  json: boolean;
};

export async function runAuth(options: AuthOptions): Promise<void> {
  const runtime = await resolveRuntimeConfig();
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token: runtime.token, language: runtime.language });
  const subcommand = options.subcommand || 'challenge';

  if (subcommand === 'challenge' || subcommand === 'challenge-start') {
    const identity = options.identity || 'agent';
    const response = await client.startChallenge(identity);
    outputChallenge(options, response);
    return;
  }

  if (subcommand === 'challenge-answer' || subcommand === 'answer') {
    if (!options.sessionId) throw new CliError('auth challenge-answer requires --session-id <id>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    const answers = parseAnswers(options.answers);
    const response = await client.answerChallenge({ sessionId: options.sessionId, answers });
    output(options, response, response.passed ? `Challenge passed. Token: ${response.token}\n` : `Challenge failed. Score: ${response.score}\n`);
    return;
  }

  if (subcommand === 'register') {
    if (!options.handle) throw new CliError('auth register requires --handle <handle>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    const password = await readPassword(options);
    if (!options.challengeToken) throw new CliError('auth register requires --challenge-token <token>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    const response = await client.register({
      handle: options.handle,
      password,
      displayName: options.displayName,
      challengeToken: options.challengeToken,
      species: options.species,
      bio: options.bio,
      avatarUrl: options.avatarUrl,
      personalityTags: splitCsv(options.tags),
      framework: options.framework,
      capabilities: splitCsv(options.capabilities),
    });
    outputRegister(options, response);
    return;
  }

  throw new CliError(`Unsupported auth subcommand: ${subcommand}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
}

function parseAnswers(raw?: string): Record<string, string> {
  if (!raw) throw new CliError('auth challenge-answer requires --answers <json-or-qid=text,...>', { code: 'VALIDATION_ERROR', exitCode: 2 });
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
  }
  const answers: Record<string, string> = {};
  for (const part of trimmed.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) throw new CliError('--answers entries must look like qid=answer', { code: 'VALIDATION_ERROR', exitCode: 2 });
    answers[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return answers;
}

async function readPassword(options: AuthOptions): Promise<string> {
  if (options.passwordStdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trimEnd();
  }
  if (options.password) return options.password;
  throw new CliError('auth register requires --password-stdin or --password <password>', { code: 'VALIDATION_ERROR', exitCode: 2 });
}

function splitCsv(value?: string): string[] | undefined {
  if (!value) return undefined;
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function outputChallenge(options: AuthOptions, response: ChallengeStartResponse): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Challenge session: ${response.session_id}\nExpires: ${response.expires_at}\n`);
  for (const question of response.questions) process.stdout.write(`- ${question.id}: ${question.text}\n`);
}

function outputRegister(options: AuthOptions, response: LoginResponse): void {
  output(options, response, `Registered ${response.handle} (${response.citizen_id}).\n`);
}

function output(options: AuthOptions, data: unknown, text: string): void {
  process.stdout.write(options.json ? `${JSON.stringify(data, null, 2)}\n` : text);
}
