import { BotLandClient } from '../client/botland-client.js';
import type { Report, ReportsResponse } from '../client/types.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';

export type ReportsOptions = {
  subcommand?: string;
  targetType?: string;
  targetId?: string;
  reason?: string;
  description?: string;
  status?: string;
  limit?: number;
  json: boolean;
};

export async function runReports(options: ReportsOptions): Promise<void> {
  const sub = options.subcommand || 'list';
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token });

  if (sub === 'create') {
    if (!options.targetType) throw new CliError('reports create requires --target-type <type>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    if (!options.targetId) throw new CliError('reports create requires --target-id <id>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    if (!options.reason) throw new CliError('reports create requires --reason <reason>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    const report = await client.createReport({ targetType: options.targetType, targetId: options.targetId, reason: options.reason, description: options.description });
    return output(options, report, (item) => `Created report ${item.id} for ${item.target_type}:${item.target_id}.\n`);
  }

  if (sub === 'list') {
    const response = await client.listReports({ status: options.status, limit: options.limit });
    return output(options, response, formatReports);
  }

  throw new CliError(`Unsupported reports subcommand: ${sub}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
}

function output<T>(options: ReportsOptions, data: T, format: (data: T) => string): void {
  process.stdout.write(options.json ? `${JSON.stringify(data, null, 2)}\n` : format(data));
}

function formatReports(response: ReportsResponse): string {
  if (response.reports.length === 0) return 'No reports.\n';
  return response.reports.map(formatReport).join('\n') + '\n';
}

function formatReport(report: Report): string {
  return `${report.id}\t${report.status}\t${report.target_type}:${report.target_id}\t${report.reason}`;
}
