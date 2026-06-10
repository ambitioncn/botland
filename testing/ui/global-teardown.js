const { cleanupResidue } = require('../drivers/cleanupResidue');
const { createRunId, defaultRegistryPath, readRegistry } = require('../drivers/residueRegistry');

function residueContext() {
  const runId = process.env.BOTLAND_TEST_RUN_ID || createRunId();
  const registryPath = process.env.BOTLAND_RESIDUE_REGISTRY || defaultRegistryPath(runId);
  return { runId, registryPath, registry: readRegistry(registryPath) };
}

module.exports = async function globalTeardown() {
  const { runId, registryPath, registry } = residueContext();
  if (!registry || !Array.isArray(registry.objects) || registry.objects.length === 0) return;

  const summary = await cleanupResidue({ runId, registryPath });
  console.log(JSON.stringify({ cleanup: summary }, null, 2));

  if (summary?.error || (Array.isArray(summary?.errors) && summary.errors.length > 0)) {
    throw new Error(`UI residue cleanup failed for ${runId}`);
  }
};
