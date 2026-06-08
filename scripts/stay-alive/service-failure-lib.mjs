import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const WORKSPACE = process.cwd();

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort();
}

export function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function failureFingerprint(unit) {
  const properties = unit.properties ?? {};
  return sha256({
    unit_name: unit.unit_name,
    active_state: properties.ActiveState ?? null,
    sub_state: properties.SubState ?? null,
    result: properties.Result ?? null,
    exec_main_code: properties.ExecMainCode ?? null,
    exec_main_status: properties.ExecMainStatus ?? null,
    invocation_id: properties.InvocationID ?? null
  });
}

export function isFailedService(unit) {
  if (!unit || unit.type !== 'service' || unit.exists !== true) return false;
  const properties = unit.properties ?? {};
  return properties.ActiveState === 'failed'
    || properties.Result === 'failed'
    || unit.issues?.some((issue) => issue.code === 'service_failed');
}

export function compactFailedService(unit) {
  const properties = unit.properties ?? {};
  return {
    unit_name: unit.unit_name,
    type: unit.type,
    fingerprint: failureFingerprint(unit),
    active_state: properties.ActiveState ?? null,
    sub_state: properties.SubState ?? null,
    result: properties.Result ?? null,
    exec_main_code: properties.ExecMainCode ?? null,
    exec_main_status: properties.ExecMainStatus ?? null,
    invocation_id: properties.InvocationID ?? null,
    issues: unit.issues ?? [],
    systemctl_status: unit.systemctl_status ?? null,
    systemctl_stderr: unit.systemctl_stderr ?? null
  };
}
export function readServiceFailureLedgers(agentDir) {
  const inspections = listJsonFiles(path.join(agentDir, 'service_failure_inspections'))
    .map((file) => ({ ...readJson(file), ledger_path: path.relative(WORKSPACE, file) }));
  const recoveries = listJsonFiles(path.join(agentDir, 'service_failure_recoveries'))
    .map((file) => ({ ...readJson(file), ledger_path: path.relative(WORKSPACE, file) }));
  return { inspections, recoveries };
}

export function latestMatchingLedger(ledgers, unitName, fingerprint) {
  return ledgers
    .filter((ledger) => ledger.unit_name === unitName && ledger.failure_fingerprint === fingerprint)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0] ?? null;
}

export function classifyFailedService(unit, ledgers) {
  const failed = compactFailedService(unit);
  const latestInspection = latestMatchingLedger(ledgers.inspections, failed.unit_name, failed.fingerprint);
  const latestRecovery = latestMatchingLedger(ledgers.recoveries, failed.unit_name, failed.fingerprint);
  return {
    ...failed,
    inspected: Boolean(latestInspection),
    recovered: Boolean(latestRecovery),
    inspection_action_id: latestInspection?.action_id ?? null,
    inspection_path: latestInspection?.ledger_path ?? null,
    recovery_action_id: latestRecovery?.action_id ?? null,
    recovery_path: latestRecovery?.ledger_path ?? null
  };
}
