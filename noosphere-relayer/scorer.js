import Anthropic from '@anthropic-ai/sdk';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TIMEOUT_MS = 5_000;
export const SCORER_VERSION = 'noosphere-scorer-v1.0';
const POLICY_URL = new URL('./scoring-policy/v1.0.0.json', import.meta.url);
const POLICY = JSON.parse(readFileSync(POLICY_URL, 'utf8'));

const SYSTEM_PROMPT = `You are an objective AI output quality evaluator.
Score the agent output from -10 to +10:
-10 completely wrong or harmful; -5 poor with significant issues; 0 neutral;
+5 good and mostly correct; +10 excellent and optimal.
Evaluate accuracy, completeness, code quality when applicable, and reasoning.
Respond ONLY with valid JSON:
{"score":0,"reasoning":"One sentence.","dimensions":{"accuracy":0,"completeness":0,"code_quality":0,"reasoning":0}}
Every dimension must be an integer from -2 to +2.`;

verifyPolicy();

export async function scoreAction(action, projectContext) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return signScoreResult(
      fallbackScore(new Error('ANTHROPIC_API_KEY is not configured')),
      action,
    );
  }

  try {
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL,
      maxRetries: 0,
      timeout: TIMEOUT_MS,
    });
    const message = await client.messages.create(
      {
        model: POLICY.model,
        max_tokens: 300,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Project context:
${projectContext || '(No previous project context.)'}

Agent: ${action.agent_id}
Action type: ${action.action_type}
Output to evaluate:
${action.content}`,
          },
        ],
      },
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );

    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    return signScoreResult(
      normalizeScore(JSON.parse(stripCodeFence(text))),
      action,
    );
  } catch (error) {
    return signScoreResult(fallbackScore(error), action);
  }
}

function normalizeScore(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('Scorer response must be an object');
  }

  const dimensions = {};
  for (const dimension of POLICY.dimensions) {
    const value = result.dimensions?.[dimension.name];
    const [minimum, maximum] = dimension.range;
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`Invalid scorer dimension: ${dimension.name}`);
    }
    dimensions[dimension.name] = value;
  }

  const weightedDimensionScore = POLICY.dimensions.reduce(
    (total, dimension) =>
      total + dimensions[dimension.name] * dimension.weight,
    0,
  );
  const dimensionMaximum = Math.max(
    ...POLICY.dimensions.map(({ range }) => Math.abs(range[1])),
  );
  const scoreDelta = clamp(
    Math.round((weightedDimensionScore / dimensionMaximum) * POLICY.scale.max),
    POLICY.scale.min,
    POLICY.scale.max,
  );
  const reasoning =
    typeof result.reasoning === 'string' && result.reasoning.trim()
      ? result.reasoning.trim()
      : 'No scoring explanation was provided.';

  return {
    score_delta: scoreDelta,
    reasoning,
    dimensions,
    automatic: true,
    score_status: 'scored',
    scorer_model: POLICY.model,
    scorer_version: SCORER_VERSION,
    scoring_policy_version: POLICY.version,
  };
}

export function neutralScore() {
  return {
    score_delta: 0,
    reasoning: 'Scorer unavailable, using neutral score.',
    dimensions: {
      accuracy: 0,
      completeness: 0,
      code_quality: 0,
      reasoning: 0,
    },
    automatic: true,
    score_status: 'fallback',
    scorer_model: POLICY.model,
    scorer_version: SCORER_VERSION,
    scoring_policy_version: POLICY.version,
  };
}

export async function signScoreResult(result, action) {
  try {
    const keypair = getScorerKeypair();
    const payload = createScoreSigningPayload({
      score_delta: result.score_delta,
      content: action.content,
      timestamp: action.timestamp,
    });
    const { signature } = await keypair.signPersonalMessage(payload);

    return {
      ...result,
      scored_by: keypair.getPublicKey().toSuiPublicKey(),
      score_signature: signature,
    };
  } catch (error) {
    console.warn('[scorer] Score signature unavailable:', error.message);
    return {
      ...result,
      scored_by: null,
      score_signature: null,
    };
  }
}

export function createScoreSigningPayload({
  score_delta,
  content,
  timestamp,
}) {
  if (!Number.isInteger(score_delta)) {
    throw new Error('score_delta is required for score signing');
  }
  if (typeof content !== 'string') {
    throw new Error('content is required for score signing');
  }
  if (!Number.isSafeInteger(timestamp)) {
    throw new Error('timestamp is required for score signing');
  }

  return new TextEncoder().encode(
    JSON.stringify({ score_delta, content, timestamp }),
  );
}

export function getScoringPolicy() {
  return structuredClone(POLICY);
}

function fallbackScore(error) {
  console.warn('Scorer unavailable, using neutral score');
  if (process.env.NODE_ENV === 'development') {
    console.warn('[scorer]', error.message);
  }
  return neutralScore();
}

function stripCodeFence(value) {
  return value
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

let scorerKeypair;

function getScorerKeypair() {
  if (scorerKeypair) {
    return scorerKeypair;
  }

  const encoded = process.env.SCORER_PRIVATE_KEY;
  if (!encoded) {
    throw new Error('SCORER_PRIVATE_KEY is not configured');
  }

  const decoded = decodeBase64(encoded);
  let scheme = 0;
  let secretKey = decoded;

  if (decoded.length === 33) {
    [scheme] = decoded;
    secretKey = decoded.slice(1);
  } else if (decoded.length !== 32) {
    throw new Error(
      'SCORER_PRIVATE_KEY must decode to a 32-byte key or 33-byte Sui keystore value',
    );
  }

  switch (scheme) {
    case 0:
      scorerKeypair = Ed25519Keypair.fromSecretKey(secretKey);
      break;
    case 1:
      scorerKeypair = Secp256k1Keypair.fromSecretKey(secretKey);
      break;
    case 2:
      scorerKeypair = Secp256r1Keypair.fromSecretKey(secretKey);
      break;
    default:
      throw new Error(`Unsupported scorer signature scheme flag: ${scheme}`);
  }

  return scorerKeypair;
}

function decodeBase64(value) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error('SCORER_PRIVATE_KEY is not valid base64');
  }

  return new Uint8Array(Buffer.from(normalized, 'base64'));
}

function verifyPolicy() {
  const promptHash = createHash('sha256').update(SYSTEM_PROMPT).digest('hex');
  if (promptHash !== POLICY.prompt_hash) {
    throw new Error(
      `Scoring policy prompt hash mismatch: expected ${POLICY.prompt_hash}, got ${promptHash}`,
    );
  }

  const totalWeight = POLICY.dimensions.reduce(
    (total, dimension) => total + dimension.weight,
    0,
  );
  if (Math.abs(totalWeight - 1) > Number.EPSILON) {
    throw new Error('Scoring policy dimension weights must total 1');
  }
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
