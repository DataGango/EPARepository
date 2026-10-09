const $ = id => document.getElementById(id);
let jobs = [];
const nextStatuses = { queued: ['processing', 'cancelled'], processing: ['completed', 'cancelled'], completed: [], cancelled: [] };
const actionNames = { processing: 'Start processing', completed: 'Mark completed', cancelled: 'Cancel job' };

function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').classList.toggle('error', error);
}

async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function render() {
  const counts = Object.keys(nextStatuses).map(status => `${jobs.filter(job => job.status === status).length} ${status}`);
  $('counts').textContent = `${jobs.length} total · ${counts.join(' · ')}`;
  $('jobs').replaceChildren();
  const visible = jobs.filter(job => !$('filter').value || job.status === $('filter').value);
  $('empty').hidden = visible.length !== 0;
  for (const job of visible) {
    const item = element('li', undefined, 'job');
    const details = element('div');
    details.append(element('h3', job.name), element('span', job.status, `status ${job.status}`),
      element('p', `${job.copies} ${job.copies === 1 ? 'copy' : 'copies'} · ${job.pages} pages each · ${job.color === 'mono' ? 'Monochrome' : 'Color'} · ${job.paper} · ${job.duplex ? 'Double-sided' : 'Single-sided'}`),
      element('small', `Created ${new Date(job.createdAt).toLocaleString()} · Updated ${new Date(job.updatedAt).toLocaleString()}`));
    const actions = element('div', undefined, 'actions');
    for (const status of nextStatuses[job.status]) {
      const button = element('button', actionNames[status], status === 'cancelled' ? 'secondary' : '');
      button.type = 'button';
      button.setAttribute('aria-label', `${actionNames[status]}: ${job.name}`);
      button.addEventListener('click', async () => {
        if (status === 'cancelled' && !window.confirm(`Cancel "${job.name}"? This cannot be undone.`)) return;
        for (const control of actions.children) control.disabled = true;
        try {
          const { job: updated } = await api(`/api/jobs/${job.id}/status`, 'PATCH', { status });
          jobs = jobs.map(existing => existing.id === updated.id ? updated : existing);
          render();
          feedback(`${updated.name}: ${updated.status}. Status is manual; no printing occurred.`);
          $('refresh').focus();
        } catch (error) {
          feedback(error.message, true);
          for (const control of actions.children) control.disabled = false;
        }
      });
      actions.append(button);
    }
    item.append(details, actions);
    $('jobs').append(item);
  }
}

async function refresh() {
  $('refresh').disabled = true;
  try {
    jobs = (await api('/api/jobs')).jobs;
    render();
  } catch (error) {
    feedback(`Could not load queue: ${error.message}`, true);
    $('counts').textContent = 'Queue unavailable. Try Refresh queue.';
  } finally {
    $('refresh').disabled = false;
  }
}

$('filter').addEventListener('change', render);
$('refresh').addEventListener('click', refresh);
$('assistant-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('draft-button').disabled = true;
  $('warnings').replaceChildren();
  try {
    const result = await api('/api/assistant', 'POST', { prompt: $('prompt').value });
    for (const field of ['name', 'copies', 'pages', 'color', 'paper']) $(field).value = result.draft[field];
    $('duplex').checked = result.draft.duplex;
    $('warnings').replaceChildren(...result.warnings.map(warning => element('li', warning)));
    feedback(`Editable draft ready (${result.mode === 'local' ? 'local rules, not an LLM' : 'OpenAI'}). Review settings and choose Add to queue. No job created.`);
    $('name').focus();
  } catch (error) {
    feedback(error.message, true);
  } finally {
    $('draft-button').disabled = false;
  }
});
$('job-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    const draft = Object.fromEntries(['name', 'color', 'paper'].map(field => [field, $(field).value]));
    draft.copies = Number($('copies').value);
    draft.pages = Number($('pages').value);
    draft.duplex = $('duplex').checked;
    const { job } = await api('/api/jobs', 'POST', draft);
    jobs.unshift(job);
    $('filter').value = '';
    render();
    $('job-form').reset();
    $('warnings').replaceChildren();
    feedback(`${job.name} added to the queue. No physical printing occurs.`);
    $('name').focus();
  } catch (error) {
    feedback(error.message, true);
  } finally {
    button.disabled = false;
  }
});

async function initialize() {
  await refresh();
  try {
    const config = await api('/api/config');
    $('assistant-mode').textContent = config.assistantMode === 'local'
      ? 'Local rules mode — deterministic parser, NOT an LLM. No prompt leaves this server.'
      : 'OpenAI mode — submitting a prompt sends it to OpenAI. Do not include confidential information.';
    $('draft-button').disabled = false;
  } catch (error) {
    $('assistant-mode').textContent = 'Assistant unavailable. Use the manual form.';
    feedback(error.message, true);
  }
}
initialize();
