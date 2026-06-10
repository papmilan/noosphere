import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.join(directory, 'project_registry.json');
const temporaryPath = `${registryPath}.tmp`;

let writeQueue = Promise.resolve();

export async function addProjectAction(
  projectId,
  {
    blobId,
    genomeObjectId,
    agentId,
    provider,
    model,
    client,
    scoreDelta,
    actionId,
    txDigest,
    scoreBreakdown,
    scoreReasoning,
    scoreAutomatic,
    scoreStatus,
    scorerModel,
    scorerVersion,
    scoredBy,
    scoreSignature,
    scoringPolicyVersion,
  },
) {
  const operation = writeQueue.then(async () => {
    const registry = await readRegistry();
    const project = registry.projects[projectId] || {
      blob_ids: [],
      genome_object_ids: [],
      agents: {},
      action_receipts: {},
    };
    project.agents ||= {};
    project.action_receipts ||= {};

    if (!project.blob_ids.includes(blobId)) {
      project.blob_ids.push(blobId);
    }
    if (!project.genome_object_ids.includes(genomeObjectId)) {
      project.genome_object_ids.push(genomeObjectId);
    }

    const agent = project.agents[genomeObjectId] || {
      genome_object_id: genomeObjectId,
      agent_name: agentId,
      provider: provider || null,
      model: model || null,
      client: client || null,
      reputation_score: 500,
      decision_count: 0,
    };
    agent.agent_name = agentId;
    agent.provider = provider || agent.provider || null;
    agent.model = model || agent.model || null;
    agent.client = client || agent.client || null;
    agent.reputation_score = Math.max(
      0,
      Math.min(1000, agent.reputation_score + scoreDelta),
    );
    agent.decision_count += 1;
    project.agents[genomeObjectId] = agent;
    project.action_receipts[actionId] = {
      blob_id: blobId,
      tx_digest: txDigest,
      genome_object_id: genomeObjectId,
      agent_id: agentId,
      score_delta: scoreDelta,
      score_breakdown: scoreBreakdown,
      score_reasoning: scoreReasoning,
      score_automatic: scoreAutomatic,
      score_status: scoreStatus,
      scorer_model: scorerModel,
      scorer_version: scorerVersion,
      scored_by: scoredBy,
      score_signature: scoreSignature,
      scoring_policy_version: scoringPolicyVersion,
    };

    registry.projects[projectId] = project;
    await writeRegistry(registry);
  });

  writeQueue = operation.catch(() => {});
  return operation;
}

export async function getProjectBlobIds(projectId) {
  await writeQueue;
  const registry = await readRegistry();
  return [...(registry.projects[projectId]?.blob_ids || [])];
}

export async function getProjectGenomeIds(projectId) {
  await writeQueue;
  const registry = await readRegistry();
  return [...(registry.projects[projectId]?.genome_object_ids || [])];
}

export async function getProjectDemoAgents(projectId) {
  await writeQueue;
  const registry = await readRegistry();
  return Object.values(registry.projects[projectId]?.agents || {});
}

export async function getActionReceipt(projectId, actionId) {
  await writeQueue;
  const registry = await readRegistry();
  return registry.projects[projectId]?.action_receipts?.[actionId] || null;
}

export async function getProjectActionReceipts(projectId) {
  await writeQueue;
  const registry = await readRegistry();
  return { ...(registry.projects[projectId]?.action_receipts || {}) };
}

async function readRegistry() {
  try {
    const contents = await readFile(registryPath, 'utf8');
    const registry = JSON.parse(contents);
    if (!registry.projects || typeof registry.projects !== 'object') {
      throw new Error('Registry is missing its projects object');
    }

    return registry;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { projects: {} };
    }

    throw new Error(`Could not read project registry: ${error.message}`, {
      cause: error,
    });
  }
}

async function writeRegistry(registry) {
  await mkdir(directory, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`);
  await rename(temporaryPath, registryPath);
}
