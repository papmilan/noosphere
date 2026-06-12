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
const projectForm = document.querySelector('#project-form');
const projectButton = document.querySelector('#project-button');
const projectResult = document.querySelector('#project-result');
const projectList = document.querySelector('#project-list');
const credentialStatus = document.querySelector('#credential-status');

void initialize();

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

projectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(projectButton, true, 'Adding...');
  projectResult.replaceChildren();

  try {
    const response = await fetch('/v1/local/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: projectForm.elements.path.value.trim(),
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Project registration failed');
    }

    const message = document.createElement('p');
    message.className = 'success';
    message.textContent =
      `${result.project.project_id || 'Project'} is registered. ` +
      'The background watcher will start automatically.';
    projectResult.replaceChildren(message);
    projectForm.reset();
    await loadLocalProjects();
  } catch (error) {
    renderError(projectResult, error);
  } finally {
    setBusy(projectButton, false, 'Add project');
  }
});

async function initialize() {
  updateIntegration();
  void loadLocalProjects();
  void loadCredentialStatus();
  try {
    const response = await fetch('/ready');
    const health = await response.json();
    const mode =
      health.memory?.mode === 'demo'
        ? 'Demo memory'
        : health.queue?.paused_until
          ? `Walrus queue cooling down until ${new Date(
              health.queue.paused_until,
            ).toLocaleTimeString()}`
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

async function loadCredentialStatus() {
  try {
    const response = await fetch('/v1/local/credentials/status');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    credentialStatus.textContent = result.configured
      ? `Credentials ready: ${result.network} / ${result.backend}`
      : `Credentials are not configured. Run "noosphere setup" in a terminal.`;
  } catch {
    credentialStatus.textContent =
      'Credential status is available only from the local Noosphere service.';
  }
}

async function loadLocalProjects() {
  try {
    const response = await fetch('/v1/local/projects/state');
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Project manager unavailable');
    }
    renderLocalProjects(result.states);
  } catch (error) {
    projectList.replaceChildren();
    const message = document.createElement('p');
    message.className = 'empty';
    message.textContent =
      'Local project registration is unavailable from this Noosphere instance.';
    projectList.append(message);
  }
}

function renderLocalProjects(projects) {
  if (!projects.length) {
    projectList.innerHTML =
      '<p class="empty">No repositories registered yet. Add the first one above.</p>';
    return;
  }

  projectList.replaceChildren(
    ...projects.map((project) => {
      const row = document.createElement('article');
      const identity = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = project.project_id;
      const location = document.createElement('code');
      location.textContent = project.path;

      const details = document.createElement('div');
      details.className = 'project-details';
      if (project.last_checkpoint_at) {
        const cp = document.createElement('small');
        cp.textContent =
          `Last checkpoint: ` +
          `${new Date(project.last_checkpoint_at).toLocaleString()} | `;
        details.append(cp);
      }
      if (project.pending_count > 0) {
        const pending = document.createElement('small');
        pending.textContent = `Pending uploads: ${project.pending_count} | `;
        details.append(pending);
      }
      if (project.latest_failure) {
        const fail = document.createElement('small');
        fail.style.color = 'red';
        fail.textContent = `Failure: ${project.latest_failure.message || project.latest_failure}`;
        details.append(fail);
      }
      identity.append(name, location, details);

      const state = document.createElement('span');
      state.textContent = project.enabled === false ? 'Paused' : 'Watching';
      state.dataset.state =
        project.enabled === false ? 'paused' : 'watching';

      const controls = document.createElement('div');
      controls.className = 'project-controls';
      controls.style.display = 'flex';
      controls.style.gap = '8px';
      controls.style.marginTop = '8px';

      const toggleBtn = document.createElement('button');
      toggleBtn.textContent = project.enabled === false ? 'Resume' : 'Pause';
      toggleBtn.type = 'button';
      toggleBtn.onclick = () =>
        projectAction(
          project.project_id,
          project.enabled === false ? 'resume' : 'pause',
        );

      const forgetBtn = document.createElement('button');
      forgetBtn.textContent = 'Forget';
      forgetBtn.type = 'button';
      forgetBtn.onclick = () => projectAction(project.project_id, 'forget');

      controls.append(toggleBtn, forgetBtn);

      if (project.latest_failure || project.pending_count > 0) {
        const retryBtn = document.createElement('button');
        retryBtn.textContent = 'Retry Upload';
        retryBtn.type = 'button';
        retryBtn.onclick = () =>
          projectAction(
            project.project_id,
            'retry',
            project.retry_job_id,
          );
        controls.append(retryBtn);
      }

      identity.append(controls);

      row.append(identity, state);
      return row;
    }),
  );
}

async function projectAction(projectId, action, jobId = null) {
  if (
    action === 'forget' &&
    !window.confirm(
      'Forget this project locally? Files and Walrus memories are not deleted.',
    )
  ) {
    return;
  }
  try {
    const response = await fetch(
      `/v1/local/projects/${encodeURIComponent(projectId)}/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: jobId ? JSON.stringify({ job_id: jobId }) : undefined,
      },
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Failed to ${action}`);
    await loadLocalProjects();
  } catch (error) {
    renderError(projectResult, error);
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

// Install section — OS detection, tab switching, copy buttons
(function initInstall() {
  const osTabs = document.querySelectorAll('.install-os-tab');
  const panels = document.querySelectorAll('.install-panel');

  function detectOs() {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('win')) return 'windows';
    if (ua.includes('linux')) return 'linux';
    return 'mac';
  }

  function switchOs(os) {
    osTabs.forEach((tab) => {
      const on = tab.dataset.os === os;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', String(on));
    });
    panels.forEach((panel) => {
      panel.classList.toggle('hidden', panel.dataset.os !== os);
    });
  }

  osTabs.forEach((tab) => tab.addEventListener('click', () => switchOs(tab.dataset.os)));
  switchOs(detectOs());

  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      const original = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('copied');
      }, 2000);
    });
  });
}());
