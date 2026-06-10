const form = document.querySelector('#action-form');
const statusElement = document.querySelector('#status');
const resultElement = document.querySelector('#result');
const contextElement = document.querySelector('#context');
const agentsElement = document.querySelector('#agents');
const ratingsElement = document.querySelector('#ratings');
const submitButton = document.querySelector('#submit-button');
const copyButton = document.querySelector('#copy-button');
const copyCommandButton = document.querySelector('#copy-command-button');
const integrationCommand = document.querySelector('#integration-command');
const textContextLink = document.querySelector('#text-context-link');

let currentContext = '';

await initialize();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  submitButton.textContent = 'Storing...';
  resultElement.textContent = '';

  const data = Object.fromEntries(new FormData(form));

  try {
    const response = await fetch('/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Action failed');
    }

    renderScoreResult(result);
    form.elements.content.value = '';
    await refreshProject();
  } catch (error) {
    resultElement.textContent = error.message;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Store to Noosphere';
  }
});

form.elements.project_id.addEventListener('change', refreshProject);
form.addEventListener('input', updateIntegrationCommand);

copyButton.addEventListener('click', async () => {
  await copyWithFeedback(
    copyButton,
    currentContext,
    'Copy context',
    contextElement,
  );
});

copyCommandButton.addEventListener('click', async () => {
  await copyWithFeedback(
    copyCommandButton,
    integrationCommand.textContent,
    'Copy request',
    integrationCommand,
  );
});

async function initialize() {
  try {
    const response = await fetch('/health');
    const health = await response.json();
    const network = health.demo_mode ? 'Local demo mode' : 'Sui testnet';
    statusElement.textContent = health.scorer_configured
      ? `${network} · scorer online`
      : `${network} · scorer unavailable`;
    updateIntegrationCommand();
    await refreshProject();
  } catch {
    statusElement.textContent = 'Relayer unavailable';
    contextElement.textContent = 'Could not connect to the relayer.';
  }
}

async function refreshProject() {
  const projectId = form.elements.project_id.value.trim();
  if (!projectId) return;
  textContextLink.href = `/v1/projects/${encodeURIComponent(projectId)}/context?format=text`;

  const [contextResponse, agentsResponse] = await Promise.all([
    fetch(`/context/${encodeURIComponent(projectId)}`),
    fetch(`/agents/${encodeURIComponent(projectId)}`),
  ]);
  const contextData = await contextResponse.json();
  const agentsData = await agentsResponse.json();

  currentContext = contextData.context || '';
  contextElement.textContent = currentContext;
  const actions = contextData.actions || [];
  renderRatings(actions);
  renderAgents(agentsData.agents || [], actions);
}

function renderAgents(agents, actions) {
  if (agents.length === 0) {
    agentsElement.innerHTML =
      '<p class="empty">No actions recorded for this project.</p>';
    return;
  }

  const rankedAgents = agents
    .map((agent) => {
      const ratings = actions
        .filter((action) => isVerifiedRating(action))
        .filter(
          (action) =>
            action.genome_object_id === agent.genome_object_id ||
            (!action.genome_object_id &&
              action.agent_id === agent.agent_name),
        )
        .map((action) => Number(action.score_delta));
      const averageRating =
        ratings.length > 0
          ? ratings.reduce((total, score) => total + score, 0) /
            ratings.length
          : null;
      return { ...agent, average_rating: averageRating, rating_count: ratings.length };
    })
    .sort(
      (a, b) =>
        (b.average_rating ?? -Infinity) - (a.average_rating ?? -Infinity) ||
        (b.reputation_score ?? 0) - (a.reputation_score ?? 0),
    );

  agentsElement.replaceChildren(
    ...rankedAgents.map((agent, index) => {
      const card = document.createElement('article');
      card.className = 'agent-card';

      const rank = document.createElement('span');
      rank.className = 'agent-rank';
      rank.textContent = `#${index + 1}`;

      const name = document.createElement('h3');
      name.className = 'agent-name';
      name.textContent = agent.agent_name || 'Unnamed agent';

      const id = document.createElement('p');
      id.className = 'agent-id';
      id.textContent = agent.genome_object_id;

      const decisions = document.createElement('p');
      decisions.className = 'agent-decisions';
      const identity = [agent.provider, agent.model, agent.client]
        .filter(Boolean)
        .join(' / ');
      decisions.textContent = `${agent.decision_count ?? 0} decisions${
        identity ? ` | ${identity}` : ''
      }`;

      const rating = document.createElement('p');
      rating.className = 'agent-rating';
      rating.textContent =
        agent.average_rating === null
          ? 'No verified AI ratings yet'
          : `${formatSignedScore(agent.average_rating, 1)} average rating / 10 · ${agent.rating_count} verified`;

      const reputation = document.createElement('p');
      reputation.className = 'agent-reputation-label';
      reputation.textContent = `On-chain reputation ${agent.reputation_score ?? '-'}`;

      const score = document.createElement('div');
      score.className = 'agent-score';
      score.textContent = agent.reputation_score ?? '-';

      card.append(rank, name, id, decisions, rating, reputation, score);
      return card;
    }),
  );
}

function renderRatings(actions) {
  const ratings = [...actions].reverse();
  if (ratings.length === 0) {
    ratingsElement.innerHTML =
      '<p class="empty">No rated outputs for this project.</p>';
    return;
  }

  ratingsElement.replaceChildren(
    ...ratings.map((action) => {
      const card = document.createElement('article');
      card.className = 'rating-card';

      const header = document.createElement('div');
      header.className = 'rating-header';

      const identity = document.createElement('div');
      const title = document.createElement('h3');
      title.textContent = action.agent_id || 'Unnamed agent';
      const model = document.createElement('p');
      model.className = 'rating-identity';
      model.textContent =
        [action.provider, action.model, action.client]
          .filter(Boolean)
          .join(' / ') || action.action_type;
      identity.append(title, model);

      const score = document.createElement('strong');
      const numericScore = Number(action.score_delta || 0);
      const status = getRatingStatus(action);
      score.className = `ledger-score ${
        status === 'fallback'
          ? 'neutral'
          : numericScore > 0
            ? 'positive'
            : numericScore < 0
              ? 'negative'
              : 'neutral'
      }`;
      score.textContent =
        status === 'fallback' ? 'Pending' : formatSignedScore(numericScore);
      header.append(identity, score);

      const content = document.createElement('p');
      content.className = 'rating-content';
      content.textContent = action.content;

      const reasoning = document.createElement('p');
      reasoning.className = 'rating-reasoning';
      reasoning.textContent =
        status === 'fallback'
          ? 'Scoring service was unavailable. This neutral fallback is not included in rankings.'
          : action.score_reasoning || 'No scoring explanation available.';

      const dimensions = createDimensionBars(action.score_breakdown);
      const proof = document.createElement('div');
      proof.className = 'rating-proof';
      proof.append(
        createProofItem('Walrus', action.blob_id),
        createProofItem('Sui tx', action.tx_digest),
        createProofItem(
          'Scorer',
          action.scorer_model
            ? `${action.scorer_model} · policy ${action.scoring_policy_version || 'unknown'}`
            : 'Legacy rating record',
        ),
      );

      const timestamp = document.createElement('time');
      timestamp.className = 'rating-time';
      timestamp.dateTime = new Date(Number(action.timestamp)).toISOString();
      timestamp.textContent = `${timestamp.dateTime} · ${action.action_type}`;

      card.append(header, timestamp, content, reasoning);
      if (dimensions) card.append(dimensions);
      card.append(proof);
      return card;
    }),
  );
}

function createDimensionBars(breakdown) {
  if (!breakdown) return null;
  const bars = document.createElement('div');
  bars.className = 'score-breakdown ledger-breakdown';
  Object.entries(breakdown).forEach(([name, value]) => {
    const row = document.createElement('div');
    row.className = 'score-dimension';
    const label = document.createElement('span');
    label.textContent = name.replace('_', ' ');
    const track = document.createElement('div');
    track.className = 'score-track';
    const fill = document.createElement('div');
    fill.className = `score-fill ${
      value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral'
    }`;
    fill.style.width = `${Math.abs(value) * 50}%`;
    track.append(fill);
    const number = document.createElement('strong');
    number.textContent = formatSignedScore(value);
    row.append(label, track, number);
    bars.append(row);
  });
  return bars;
}

function createProofItem(label, value) {
  const item = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = `${label}: `;
  item.append(strong, document.createTextNode(value || 'Pending'));
  return item;
}

function getRatingStatus(action) {
  if (action.score_status) return action.score_status;
  return action.score_automatic &&
    !String(action.score_reasoning || '').includes('unavailable')
    ? 'scored'
    : 'fallback';
}

function isVerifiedRating(action) {
  return getRatingStatus(action) === 'scored';
}

function formatSignedScore(value, precision = 0) {
  const number = Number(value);
  const formatted = number.toFixed(precision);
  return number > 0 ? `+${formatted}` : formatted;
}

function updateIntegrationCommand() {
  const projectId =
    form.elements.project_id.value.trim() || 'your-project-id';
  const agentId = form.elements.agent_id.value.trim() || 'your-agent-id';
  const genomeObjectId =
    form.elements.genome_object_id.value.trim() || '0xYOUR_GENOME_OBJECT_ID';
  const provider = form.elements.provider.value.trim();
  const model = form.elements.model.value.trim();
  const client = form.elements.client.value.trim();

  const payload = {
    project_id: projectId,
    agent_id: agentId,
    genome_object_id: genomeObjectId,
    action_type: 'decision',
    content: 'Agent output goes here',
    session_id: 'your-session-id',
  };
  if (provider) payload.provider = provider;
  if (model) payload.model = model;
  if (client) payload.client = client;

  integrationCommand.textContent = `curl -X POST ${window.location.origin}/v1/actions \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: unique-action-id' \\
  -d '${JSON.stringify(payload, null, 2)}'`;
}

async function copyWithFeedback(button, text, idleLabel, sourceElement) {
  button.textContent = 'Copying...';
  const copied = await copyText(text);
  if (!copied && sourceElement) {
    selectElementText(sourceElement);
  }
  button.textContent = copied ? 'Copied' : 'Selected - press Cmd/Ctrl+C';
  setTimeout(() => {
    button.textContent = idleLabel;
  }, 2200);
}

async function copyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();

  try {
    if (document.execCommand('copy')) {
      return true;
    }
  } finally {
    textarea.remove();
  }

  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Clipboard API timed out')), 400);
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

function selectElementText(element) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function renderScoreResult(result) {
  const score = Number(result.score_delta || 0);
  const scoreLabel = score > 0 ? `+${score}` : String(score);
  const scoreClass = score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';

  const heading = document.createElement('div');
  heading.className = 'score-summary';

  const scoreElement = document.createElement('strong');
  scoreElement.className = `score-delta ${scoreClass}`;
  scoreElement.textContent = scoreLabel;

  const reasoning = document.createElement('span');
  reasoning.textContent =
    result.score_status === 'fallback'
      ? 'Scoring pending: neutral fallback recorded and excluded from rankings.'
      : result.score_reasoning || 'No score explanation available.';
  heading.append(scoreElement, reasoning);

  const details = document.createElement('small');
  details.className = 'storage-receipt';
  details.textContent = `Blob ${result.blob_id} | Transaction ${result.tx_digest}`;

  resultElement.replaceChildren(heading);
  const bars = createDimensionBars(result.score_breakdown);
  if (bars) resultElement.append(bars);
  resultElement.append(details);
}
