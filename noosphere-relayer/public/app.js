const actionForm = document.querySelector('#action-form');
const recallForm = document.querySelector('#recall-form');
const rememberTab = document.querySelector('#remember-tab');
const recallTab = document.querySelector('#recall-tab');
const statusElement = document.querySelector('#status');
const resultElement = document.querySelector('#result');
const memoriesElement = document.querySelector('#memories');
const resultDescription = document.querySelector('#result-description');
const submitButton = document.querySelector('#submit-button');
const recallButton = document.querySelector('#recall-button');
const integrationCommand = document.querySelector('#integration-command');

await initialize();

rememberTab.addEventListener('click', () => showMode('remember'));
recallTab.addEventListener('click', () => showMode('recall'));
actionForm.elements.project_id.addEventListener('input', updateIntegration);
actionForm.elements.agent_id.addEventListener('input', updateIntegration);

actionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(submitButton, true, 'Remembering...');
  resultElement.replaceChildren();

  const payload = Object.fromEntries(new FormData(actionForm));
  payload.session_id = crypto.randomUUID();

  try {
    const response = await fetch('/v1/actions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Memory write failed');

    renderStoredResult(result);
    actionForm.elements.content.value = '';
    recallForm.elements.query.value = payload.content.slice(0, 240);
  } catch (error) {
    renderError(resultElement, error);
  } finally {
    setBusy(submitButton, false, 'Remember this');
  }
});

recallForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(recallButton, true, 'Recalling...');
  memoriesElement.innerHTML = '<p class="empty">Searching project memory...</p>';

  const projectId = actionForm.elements.project_id.value.trim();
  const query = recallForm.elements.query.value.trim();

  try {
    const response = await fetch(
      `/v1/projects/${encodeURIComponent(projectId)}/recall`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, limit: 12 }),
      },
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Recall failed');
    renderMemories(result.memories, query);
  } catch (error) {
    renderError(memoriesElement, error);
  } finally {
    setBusy(recallButton, false, 'Recall memory');
  }
});

async function initialize() {
  updateIntegration();
  try {
    const response = await fetch('/health');
    const health = await response.json();
    const mode =
      health.memory?.mode === 'demo'
        ? 'Demo memory'
        : health.memory?.ready
          ? 'Walrus Memory ready'
          : 'Walrus Memory needs credentials';
    const scorer =
      health.scoring_mode === 'remote' && health.scorer_configured
        ? 'remote evaluation enabled'
        : 'private scoring mode';
    statusElement.textContent = `${mode} / ${scorer}`;
  } catch {
    statusElement.textContent = 'Service unavailable';
  }
}

function showMode(mode) {
  const remembering = mode === 'remember';
  actionForm.classList.toggle('hidden', !remembering);
  recallForm.classList.toggle('hidden', remembering);
  rememberTab.classList.toggle('active', remembering);
  recallTab.classList.toggle('active', !remembering);
  rememberTab.setAttribute('aria-selected', String(remembering));
  recallTab.setAttribute('aria-selected', String(!remembering));
  if (!remembering) recallForm.elements.query.focus();
}

function renderStoredResult(result) {
  const score = Number(result.score_delta || 0);
  const summary = document.createElement('div');
  summary.className = 'stored-summary';

  const mark = document.createElement('strong');
  mark.textContent = 'Stored';

  const copy = document.createElement('span');
  copy.textContent =
    result.score_status === 'scored'
      ? `${formatScore(score)} evaluation. ${result.score_reasoning}`
      : result.score_status === 'private'
        ? 'Stored without sending private content to a separate AI evaluator.'
        : 'Stored with a neutral evaluation because the scorer is unavailable.';
  summary.append(mark, copy);

  const receipt = document.createElement('small');
  receipt.textContent = `Walrus blob ${result.blob_id} / namespace ${result.namespace}`;

  resultElement.append(summary);
  const dimensions = createDimensionBars(result.score_breakdown);
  if (dimensions) resultElement.append(dimensions);
  resultElement.append(receipt);
}

function renderMemories(memories, query) {
  resultDescription.textContent = `${memories.length} memories recalled for “${query}”.`;
  if (memories.length === 0) {
    memoriesElement.innerHTML =
      '<p class="empty">No relevant Noosphere records were found in this project namespace.</p>';
    return;
  }

  memoriesElement.replaceChildren(
    ...memories.map((memory, index) => {
      const article = document.createElement('article');
      article.className = 'memory-card';

      const number = document.createElement('span');
      number.className = 'memory-number';
      number.textContent = String(index + 1).padStart(2, '0');

      const header = document.createElement('div');
      header.className = 'memory-header';
      const title = document.createElement('h3');
      title.textContent = `${memory.agent_id} / ${memory.action_type}`;
      const distance = document.createElement('span');
      distance.textContent = `${Math.max(
        0,
        Math.round((1 - Number(memory.distance || 0)) * 100),
      )}% match`;
      header.append(title, distance);

      const content = document.createElement('p');
      content.textContent = memory.content;

      const meta = document.createElement('div');
      meta.className = 'memory-meta';
      meta.append(
        createMeta(memory.timestamp),
        createMeta(
          memory.evaluation?.status === 'scored'
            ? `${formatScore(memory.evaluation.score)} evaluation`
            : memory.evaluation?.status === 'private'
              ? 'private / not externally scored'
              : 'neutral evaluation',
        ),
        createMeta(memory.model || memory.provider || 'model not recorded'),
      );

      article.append(number, header, content, meta);
      return article;
    }),
  );
}

function createDimensionBars(dimensions) {
  if (!dimensions) return null;
  const container = document.createElement('div');
  container.className = 'dimension-list';

  for (const [name, value] of Object.entries(dimensions)) {
    const row = document.createElement('div');
    row.className = 'dimension';
    const label = document.createElement('span');
    label.textContent = name.replace('_', ' ');
    const track = document.createElement('span');
    track.className = 'dimension-track';
    const fill = document.createElement('span');
    fill.className = 'dimension-fill';
    fill.style.width = `${Math.abs(value) * 50}%`;
    fill.dataset.direction =
      value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral';
    track.append(fill);
    const score = document.createElement('strong');
    score.textContent = formatScore(value);
    row.append(label, track, score);
    container.append(row);
  }
  return container;
}

function createMeta(value) {
  const span = document.createElement('span');
  span.textContent = value;
  return span;
}

function updateIntegration() {
  const projectId =
    actionForm.elements.project_id.value.trim() || 'your-project';
  const agentId =
    actionForm.elements.agent_id.value.trim() || 'your-agent';
  integrationCommand.textContent = `curl -X POST ${window.location.origin}/v1/actions \\
  -H 'Content-Type: application/json' \\
  -d '${JSON.stringify({
    project_id: projectId,
    agent_id: agentId,
    action_type: 'decision',
    content: 'What the agent decided or changed',
  })}'`;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.textContent = label;
}

function renderError(element, error) {
  const message = document.createElement('p');
  message.className = 'error';
  message.textContent = error.message;
  element.replaceChildren(message);
}

function formatScore(value) {
  const number = Number(value);
  return number > 0 ? `+${number}` : String(number);
}
