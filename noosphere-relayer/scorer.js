import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TIMEOUT_MS = 5_000;
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
  if (process.env.SCORING_MODE !== 'remote') {
    return privateScore();
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return fallbackScore(new Error('ANTHROPIC_API_KEY is not configured'));
  }

  try {
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL,
      maxRetries: 0,
      timeout: TIMEOUT_MS,
    });
    const message = await client.messages.create({
      model: POLICY.model,
      max_tokens: 300,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Project context:
${projectContext || '(No relevant project memory was recalled.)'}

Agent: ${action.agent_id}
Action type: ${action.action_type}
Output to evaluate:
${action.content}`,
        },
      ],
    });

    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    return normalizeScore(JSON.parse(stripCodeFence(text)));
  } catch (error) {
    return fallbackScore(error);
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

  return {
    score_delta: clamp(
      Math.round(
        (weightedDimensionScore / dimensionMaximum) * POLICY.scale.max,
      ),
      POLICY.scale.min,
      POLICY.scale.max,
    ),
    reasoning:
      typeof result.reasoning === 'string' && result.reasoning.trim()
        ? result.reasoning.trim()
        : 'No scoring explanation was provided.',
    dimensions,
    score_status: 'scored',
    scorer_model: POLICY.model,
    scoring_policy_version: POLICY.version,
  };
}

export function neutralScore() {
  return {
    score_delta: 0,
    reasoning: 'Scorer unavailable, using neutral evaluation.',
    dimensions: {
      accuracy: 0,
      completeness: 0,
      code_quality: 0,
      reasoning: 0,
    },
    score_status: 'fallback',
    scorer_model: POLICY.model,
    scoring_policy_version: POLICY.version,
  };
}

export function privateScore() {
  return {
    score_delta: 0,
    reasoning:
      'External evaluation disabled to keep private project content out of a second AI provider.',
    dimensions: {
      accuracy: 0,
      completeness: 0,
      code_quality: 0,
      reasoning: 0,
    },
    score_status: 'private',
    scorer_model: null,
    scoring_policy_version: POLICY.version,
  };
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

function verifyPolicy() {
  const promptHash = createHash('sha256').update(SYSTEM_PROMPT).digest('hex');
  if (promptHash !== POLICY.prompt_hash) {
    throw new Error(
      `Scoring policy prompt hash mismatch: expected ${POLICY.prompt_hash}, got ${promptHash}`,
    );
  }
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
