(() => {
  const root = document.querySelector('#pipeline-dashboard');
  if (!root) return;

  const basePath = root.dataset.basePath || '';
  const page = root.dataset.page || 'runs';
  const runId = root.dataset.runId || '';
  const nodeElements = new Map();
  let resizeObserver;
  let redrawEdges;

  globalThis.addEventListener('resize', () => redrawEdges?.(), { passive: true });

  function element(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = String(text);
    return result;
  }

  function append(parent, ...children) {
    parent.append(...children.filter(Boolean));
    return parent;
  }

  function normalizeStatus(value) {
    return String(value || 'PENDING').toUpperCase();
  }

  function statusBadge(value) {
    const status = normalizeStatus(value);
    const badge = element('span', 'status', status);
    badge.dataset.status = status;
    return badge;
  }

  function formatTime(value) {
    return value ? new Date(value).toLocaleString() : '-';
  }

  function pathFor(pathname) {
    return `${basePath}${pathname}`;
  }

  function pipelineRunPath(id) {
    return pathFor(`/pipelines/${encodeURIComponent(id)}`);
  }

  function jobPath(queueName, jobId) {
    return pathFor(
      `/queue/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}`,
    );
  }

  async function requestJson(pathname) {
    const response = await fetch(pathFor(pathname), {
      headers: { Accept: 'application/json' },
    });
    const contentType = response.headers.get('content-type') || '';

    if (response.redirected && !contentType.includes('application/json')) {
      globalThis.location.assign(response.url);
      return null;
    }

    if (!response.ok) {
      let message = `Request failed with status ${response.status}`;
      if (contentType.includes('application/json')) {
        const body = await response.json();
        if (body && body.error) message = String(body.error);
      }
      throw new Error(message);
    }

    return response.json();
  }

  function renderError(error) {
    root.replaceChildren(
      element(
        'div',
        'error',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  function renderRuns(runs) {
    const section = element('section', 'page');
    const header = element('header', 'page-header');
    const title = element('div');
    append(
      title,
      element('p', 'eyebrow', 'Last 24 hours'),
      element('h1', '', 'Pipeline runs'),
    );
    append(header, title, element('span', 'run-count', `${runs.length} runs`));
    section.append(header);

    if (runs.length === 0) {
      section.append(
        element('div', 'empty', 'No pipeline runs have reported progress yet.'),
      );
      root.replaceChildren(section);
      return;
    }

    const frame = element('div', 'table-frame');
    const table = element('table', 'runs-table');
    const head = element('thead');
    const headingRow = element('tr');
    ['Pipeline', 'Run', 'Status', 'Tasks', 'Updated'].forEach((label) => headingRow.append(element('th', '', label)));
    head.append(headingRow);

    const body = element('tbody');
    runs.forEach((run) => {
      const row = element('tr');
      const pipelineCell = element('td');
      const pipelineLink = element('a', 'pipeline-link', run.pipelineName);
      pipelineLink.href = pipelineRunPath(run.id);
      pipelineCell.append(pipelineLink);

      const runCell = element('td');
      append(
        runCell,
        element('div', 'run-name', run.name),
        element('code', '', run.id),
      );

      const statusCell = element('td');
      statusCell.append(statusBadge(run.status));

      append(
        row,
        pipelineCell,
        runCell,
        statusCell,
        element(
          'td',
          '',
          `${run.pendingNodes} pending / ${run.failedNodes} failed`,
        ),
        element('td', '', formatTime(run.updatedAt)),
      );
      body.append(row);
    });

    append(table, head, body);
    frame.append(table);
    section.append(frame);
    root.replaceChildren(section);
  }

  function layoutNodes(nodes) {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const depths = new Map();
    const visiting = new Set();

    function depthOf(node) {
      if (depths.has(node.id)) return depths.get(node.id);
      if (visiting.has(node.id)) return 0;

      visiting.add(node.id);
      const parents = (node.parentNodeIds || [])
        .map((parentId) => nodesById.get(parentId))
        .filter(Boolean);
      const depth = parents.length === 0 ? 0 : Math.max(...parents.map((parent) => depthOf(parent))) + 1;
      visiting.delete(node.id);
      depths.set(node.id, depth);
      return depth;
    }

    const columns = new Map();
    nodes.forEach((node) => {
      const depth = depthOf(node);
      if (!columns.has(depth)) columns.set(depth, new Map());
      const pipelineName = node.pipelineName || 'pipeline';
      const stepName = node.stepName || node.stage || node.name || 'unassigned';
      const key = `${pipelineName}\u0000${stepName}`;
      const groups = columns.get(depth);
      if (!groups.has(key)) {
        groups.set(key, { pipelineName, stepName, nodes: [] });
      }
      groups.get(key).nodes.push(node);
    });

    return [...columns.entries()]
      .sort(([left], [right]) => left - right)
      .map(([depth, groups]) => ({ depth, groups: [...groups.values()] }));
  }

  function nodeCard(node) {
    const card = element('article', 'node');
    card.dataset.status = normalizeStatus(node.status);
    card.dataset.nodeId = node.id;

    const header = element('div', 'node-header');
    const shortId = element('code', '', String(node.id).slice(0, 12));
    shortId.title = node.id;
    append(header, shortId, element('span', '', normalizeStatus(node.status)));

    const meta = element('div', 'node-meta');
    const parentCount = Array.isArray(node.parentNodeIds) ? node.parentNodeIds.length : 0;
    append(
      meta,
      element('span', '', `Attempt ${node.attempt}/${node.maxAttempts}`),
      element('span', '', `${parentCount} parent${parentCount === 1 ? '' : 's'}`),
    );
    append(card, header, meta);

    if (node.invocationId || node.scopeId) {
      const scope = element('div', 'scope-meta');
      if (node.invocationId) {
        const invocation = element('code', '', `invocation ${node.invocationId}`);
        invocation.title = node.invocationId;
        scope.append(invocation);
      }
      if (node.scopeId) {
        const scopeId = element('code', '', `scope ${node.scopeId}`);
        scopeId.title = node.scopeId;
        scope.append(scopeId);
      }
      card.append(scope);
    }

    const progressEntries = Object.entries(node.progress || {});
    if (progressEntries.length > 0) {
      const progress = element('div', 'progress');
      progressEntries.forEach(([key, value]) => {
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        progress.append(element('span', '', `${key}: ${text}`));
      });
      card.append(progress);
    }

    if (node.error) card.append(element('div', 'node-error', node.error));

    if (node.queueName && node.jobId) {
      const link = element('a', 'job-link', 'Open BullMQ job');
      link.href = jobPath(node.queueName, node.jobId);
      card.append(link);
    }

    return card;
  }

  function createConnectors() {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.classList.add('connectors');
    svg.setAttribute('aria-hidden', 'true');

    const definitions = document.createElementNS(namespace, 'defs');
    const marker = document.createElementNS(namespace, 'marker');
    marker.id = 'pipeline-arrow';
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('orient', 'auto');
    marker.setAttribute('refX', '5');
    marker.setAttribute('refY', '3');
    const arrow = document.createElementNS(namespace, 'path');
    arrow.classList.add('connector-arrow');
    arrow.setAttribute('d', 'M 0 0 L 6 3 L 0 6 z');
    marker.append(arrow);
    definitions.append(marker);
    svg.append(definitions);
    return svg;
  }

  function updateEdges(nodes, canvas, connectors) {
    connectors.querySelectorAll('.connector').forEach((edge) => edge.remove());
    const canvasRect = canvas.getBoundingClientRect();
    const namespace = 'http://www.w3.org/2000/svg';

    nodes.forEach((child) => {
      const childElement = nodeElements.get(child.id);
      if (!childElement) return;
      const childRect = childElement.getBoundingClientRect();

      (child.parentNodeIds || []).forEach((parentId) => {
        const parentElement = nodeElements.get(parentId);
        if (!parentElement) return;
        const parentRect = parentElement.getBoundingClientRect();
        const startX = parentRect.right - canvasRect.left;
        const startY = parentRect.top + parentRect.height / 2 - canvasRect.top;
        const endX = childRect.left - canvasRect.left;
        const endY = childRect.top + childRect.height / 2 - canvasRect.top;
        const distance = endX - startX;
        const direction = distance >= 0 ? 1 : -1;
        const curve = Math.max(32, Math.abs(distance) / 2) * direction;

        const edge = document.createElementNS(namespace, 'path');
        edge.classList.add('connector');
        edge.setAttribute(
          'd',
          `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`,
        );
        edge.setAttribute('marker-end', 'url(#pipeline-arrow)');
        connectors.append(edge);
      });
    });
  }

  function pipelineGraph(nodes) {
    nodeElements.clear();
    resizeObserver?.disconnect();

    const viewport = element('div', 'graph-viewport');
    viewport.dataset.testid = 'pipeline-graph';
    const canvas = element('div', 'graph-canvas');
    const connectors = createConnectors();
    const stages = element('div', 'stages');

    layoutNodes(nodes).forEach((column, columnIndex) => {
      const stage = element('div', 'stage');
      column.groups.forEach((group, groupIndex) => {
        const step = element('section', 'step');
        const header = element('header', 'step-header');
        const title = element('div');
        append(
          title,
          element('h2', '', group.stepName),
          element(
            'p',
            '',
            `${group.pipelineName} · ${group.nodes.length} task${group.nodes.length === 1 ? '' : 's'}`,
          ),
        );
        append(
          header,
          element(
            'span',
            'step-index',
            `${String(columnIndex + 1).padStart(2, '0')}.${
              String(
                groupIndex + 1,
              ).padStart(2, '0')
            }`,
          ),
          title,
        );

        const nodeList = element('div', 'nodes');
        group.nodes.forEach((node) => {
          const card = nodeCard(node);
          nodeElements.set(node.id, card);
          nodeList.append(card);
        });
        append(step, header, nodeList);
        stage.append(step);
      });
      stages.append(stage);
    });

    append(canvas, connectors, stages);
    viewport.append(canvas);

    redrawEdges = () => updateEdges(nodes, canvas, connectors);
    requestAnimationFrame(redrawEdges);
    if ('ResizeObserver' in globalThis) {
      resizeObserver = new ResizeObserver(redrawEdges);
      resizeObserver.observe(canvas);
      nodeElements.forEach((node) => resizeObserver.observe(node));
    }

    return viewport;
  }

  function renderRun(details) {
    const { run, nodes } = details;
    const section = element('section', 'page');
    const header = element('header', 'page-header');
    const title = element('div');
    const back = element('a', 'back-link', 'Pipeline runs');
    back.href = pathFor('/pipelines');
    append(
      title,
      back,
      element('h1', '', run.pipelineName),
      element('p', 'run-id', run.id),
    );

    const summary = element('div', 'summary');
    append(
      summary,
      element('span', 'summary-item', `${run.pendingNodes} pending`),
      element('span', 'summary-item', `${nodes.length} tasks`),
      statusBadge(run.status),
    );
    append(header, title, summary);
    section.append(header);

    if (run.error) section.append(element('div', 'run-error', run.error));
    section.append(
      nodes.length === 0 ? element('div', 'empty', 'Waiting for pipeline tasks.') : pipelineGraph(nodes),
    );
    root.replaceChildren(section);
  }

  async function loadPipelineDashboard() {
    try {
      if (page === 'run') {
        const details = await requestJson(`/api/pipelines/${encodeURIComponent(runId)}`);
        if (details) renderRun(details);
      } else {
        const response = await requestJson('/api/pipelines');
        if (response) renderRuns(response.runs || []);
      }
    } catch (error) {
      renderError(error);
    }
  }

  function pollingInterval() {
    try {
      const settings = JSON.parse(localStorage.getItem('board-settings') || '{}');
      const value = Number(settings?.state?.pollingInterval);
      return Number.isFinite(value) ? value : 5;
    } catch {
      return 5;
    }
  }

  loadPipelineDashboard();
  const interval = pollingInterval();
  if (interval > 0) {
    globalThis.setInterval(loadPipelineDashboard, interval * 1_000);
  }
})();
