const $ = id => document.getElementById(id);

// Estado compartilhado pela tela.
let state = {
  roots: [],
  references: [],
  fileCount: 0,
  extensions: [],
  lastScan: null,
  keepIndex: false,
  watchEnabled: false,
  catalogRoots: [],
  catalogAvailable: true
};
let visibleRows = [];
let activeKind = 'all';
let toastTimer;
let searchTimer;
let searchSequence = 0;
let searchMode = 'index';
let directRoots = [];
let directRows = [];
let directRequestCounter = 0;
let activeDirectRequest = null;
let scopeMode = 'folders';
let chatSearchMode = 'content';
let chatRequestCounter = 0;
let activeChatRequest = null;
let activeChatMessage = null;
let chatRows = [];
let chatIntentSequence = 0;
const GEO = new Set([
  '.shp', '.shx', '.dbf', '.prj', '.qmd', '.gpkg', '.kml', '.kmz', '.gpx',
  '.dwg', '.dxf', '.tif', '.tiff', '.ecw', '.las', '.laz', '.dem', '.dgn',
  '.gdb', '.geojson', '.gml', '.xml', '.aux', '.sid', '.img', '.vrt'
]);
const DOC = new Set(['.pdf', '.doc', '.docx', '.odt', '.rtf', '.txt', '.ppt', '.pptx']);
const TABLE = new Set(['.xls', '.xlsx', '.xlsm', '.csv', '.ods', '.tsv']);
const DIRECT_EXTENSIONS = [
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.xml', '.shp',
  '.shx', '.dbf', '.prj', '.gpkg', '.kml', '.kmz', '.gpx', '.dwg', '.dxf',
  '.tif', '.tiff', '.geojson', '.gdb', '.las', '.laz', '.dem', '.zip'
];

// Funções compartilhadas por diferentes partes da tela.
const norm = value => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('pt-BR');
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[character]));
const nicePath = p => String(p || '').replaceAll('\\', '/');

function showToast(message) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('visible');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('visible'), 3000);
}

// Atualiza os controles que indicam onde o chat vai pesquisar.
function updateChatScope() {
  if (scopeMode === 'folders') directRoots = [...(state.roots || [])];
  const label = scopeMode === 'computer'
    ? `Escopo: todo o computador (${directRoots.map(basename).join(', ') || 'unidades locais'})`
    : `Escopo: pastas adicionadas (${state.roots.length})`;

  $('scopeLabel').textContent = label;
  $('chatFoldersBtn').classList.toggle('active-scope', scopeMode === 'folders');
  $('chatComputerBtn').classList.toggle('active-scope', scopeMode === 'computer');
}

function normalizedPath(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
    .toLocaleLowerCase('pt-BR');
}

function isPathInside(child, parent) {
  const normalizedChild = normalizedPath(child);
  const normalizedParent = normalizedPath(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + '/');
}

function catalogCovers(roots) {
  return roots.length > 0
    && roots.every(root => (state.catalogRoots || []).some(item => isPathInside(root, item.root)));
}
function appendChatMessage(role, text) {
  const row = document.createElement('div');
  row.className = `chat-row ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';

  const textNode = document.createElement('div');
  textNode.className = 'chat-message-text';
  textNode.textContent = text;

  const time = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date());
  const sender = role === 'user' ? 'Você' : 'BuscaGeo';
  const meta = document.createElement('div');
  meta.className = 'chat-meta';
  meta.textContent = `${sender} · ${time}`;

  bubble.append(textNode, meta);
  row.appendChild(bubble);
  $('chatMessages').appendChild(row);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;

  return { row, bubble, textNode, meta };
}

function addChatResults(message, rows, finalMessage) {
  message.textNode.textContent = finalMessage;
  message.bubble.querySelector('.chat-result-list')?.remove();
  message.bubble.querySelector('.chat-more')?.remove();

  if (!rows.length) {
    $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
    return;
  }

  const list = document.createElement('div');
  list.className = 'chat-result-list';
  message.bubble.appendChild(list);
  let shown = Math.min(12, rows.length);

  const draw = () => {
    list.innerHTML = '';

    for (const file of rows.slice(0, shown)) {
      const card = document.createElement('div');
      card.className = 'chat-file-card';

      const name = document.createElement('strong');
      name.textContent = file.name;

      const details = document.createElement('span');
      details.className = 'chat-file-meta';
      details.textContent = `${file.ext} · ${formatSize(file.size)} · ${formatDate(file.modified)}`;

      const location = document.createElement('span');
      location.className = 'chat-file-path';
      location.textContent = file.directory;

      const excerpt = document.createElement('span');
      excerpt.className = 'chat-file-excerpt';
      excerpt.textContent = file.excerpt || '';

      const actions = document.createElement('div');
      actions.className = 'chat-file-actions';

      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Abrir arquivo';
      open.addEventListener('click', async () => {
        const error = await window.buscaGeo.openPath(file.path);
        if (error) showToast(`Não foi possível abrir: ${error}`);
      });

      const reveal = document.createElement('button');
      reveal.type = 'button';
      reveal.textContent = 'Mostrar pasta';
      reveal.addEventListener('click', () => window.buscaGeo.revealPath(file.path));

      actions.append(open, reveal);
      card.append(name, details, location);
      if (file.excerpt) card.appendChild(excerpt);
      card.appendChild(actions);
      list.appendChild(card);
    }

    message.bubble.querySelector('.chat-more')?.remove();
    if (shown < rows.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'chat-more';
      more.textContent = `Mostrar mais ${Math.min(12, rows.length - shown)} resultados`;
      more.addEventListener('click', () => {
        shown = Math.min(rows.length, shown + 12);
        draw();
      });
      message.bubble.appendChild(more);
    }

    message.bubble.appendChild(message.meta);
    $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
  };

  draw();
}
function updateLegacyIndexCard() {
  const card = $('legacyIndexCard');
  if (card) card.classList.toggle('hidden', !state.legacyIndexExists);
}

function updateAIStatus() {
  const config = state.aiConfig || {};
  const remoteUseAllowed = config.hasKey && (config.remoteConsent || config.remoteDocumentConsent);
  const configured = Boolean(config.model && (config.localEndpoint || remoteUseAllowed));

  if (configured) {
    const usage = config.localEndpoint
      ? ' · local'
      : config.remoteDocumentConsent
        ? ' · trechos autorizados'
        : ' · pergunta autorizada';
    $('aiStatus').textContent = `IA configurada · ${config.model}${usage}`;
  } else if (config.model && !config.localEndpoint && !config.hasKey) {
    $('aiStatus').textContent = 'IA remota configurada · falta chave de API';
  } else if (config.model && !config.localEndpoint && !config.remoteConsent) {
    $('aiStatus').textContent = 'IA remota desligada · autorize em Configurar IA';
  } else {
    $('aiStatus').textContent = 'Busca local pronta · configure uma IA para interpretação avançada';
  }
}
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function formatDate(value) {
  if (!value) return '—';

  const date = new Date(value);
  return Number.isNaN(+date) ? '—' : new Intl.DateTimeFormat('pt-BR').format(date);
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}min ${remainingSeconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}min`;
}

function basename(value) {
  return String(value).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value;
}

// Exibe as pastas monitoradas e as referências cadastradas.
function renderRoots() {
  $('rootCount').textContent = state.roots.length;
  $('rootsList').innerHTML = state.roots.length
    ? state.roots.map(root => `
        <div class="root-item">
          <span class="folder-icon">▰</span>
          <div class="root-text" title="${esc(root)}">
            <strong>${esc(basename(root))}</strong>
            <span>${esc(root)}</span>
          </div>
          <button class="small-x" data-remove-root="${esc(root)}" title="Remover pasta do monitoramento">×</button>
        </div>
      `).join('')
    : '<div class="side-copy">Nenhuma pasta adicionada ainda.</div>';

  document.querySelectorAll('[data-remove-root]').forEach(button => {
    button.addEventListener('click', async () => {
      state.roots = await window.buscaGeo.removeRoot(button.dataset.removeRoot);
      renderRoots();
      showToast('Pasta removida do monitoramento.');
    });
  });

  updateChatScope();
}

function renderReferences() {
  $('refCount').textContent = state.references.length;
  $('referencesList').innerHTML = state.references.length
    ? state.references.map(ref => {
      const names = [...(ref.names || [])].slice(0, 2).join(' · ') || basename(ref.path);
      const extraNames = (ref.names || []).length > 2 ? ' …' : '';
      return `
        <div class="reference-item" data-edit-ref="${esc(ref.id)}" title="Clique para editar">
          <span class="ref-icon">◈</span>
          <div>
            <strong>${esc(ref.title)}</strong>
            <span>${esc(names)}${extraNames}</span>
          </div>
        </div>
      `;
    }).join('')
    : '<div class="side-copy">Cadastre apelidos ou nomes relacionados ao projeto.</div>';

  document.querySelectorAll('[data-edit-ref]').forEach(element => {
    element.addEventListener('click', () => {
      const reference = state.references.find(item => item.id === element.dataset.editRef);
      openReference(reference);
    });
  });
}

function updateExtensionOptions() {
  const select = $('extensionSelect');
  const current = select.value;
  const extensions = searchMode === 'direct'
    ? [...new Set([...(state.extensions || []), ...DIRECT_EXTENSIONS])].sort()
    : (state.extensions || []);

  select.innerHTML = '<option value="">Todas as extensões</option>' + extensions.map(ext => `<option value="${esc(ext)}">${esc(ext)}</option>`).join('');
  if (extensions.includes(current)) select.value = current;
}

function setLastScan() {
  const pulse = document.querySelector('.pulse');

  if (state.lastScan) {
    const updatedAt = new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short'
    }).format(new Date(state.lastScan));
    $('lastScan').textContent = `Atualizado em ${updatedAt}`;
    pulse.classList.add('ok');
    return;
  }

  $('lastScan').textContent = state.fileCount
    ? 'Índice disponível'
    : 'Índice ainda não atualizado';
  pulse.classList.toggle('ok', state.fileCount > 0);
}

function updateRetention() {
  $('keepIndexToggle').checked = Boolean(state.keepIndex);
  $('retentionStatus').textContent = state.keepIndex
    ? 'Ativado: o catálogo SQLite fica salvo para a próxima sessão.'
    : 'Desativado: o catálogo temporário será removido quando o aplicativo fechar.';
  $('watchIndexToggle').checked = Boolean(state.watchEnabled);
  $('watchStatus').textContent = state.watchEnabled
    ? 'Monitoramento ativo: arquivos novos, alterados ou removidos são aplicados sem varrer tudo novamente. Após reabrir o app, a primeira atualização reconcilia mudanças ocorridas enquanto ele estava fechado.'
    : 'Monitoramento desligado. “Atualizar catálogo” fará uma varredura completa para reconciliar alterações.';
}

function renderRootsAndStats() {
  renderRoots();
  renderReferences();
  updateExtensionOptions();
  setLastScan();
  updateRetention();
  updateLegacyIndexCard();

  const directSearch = searchMode === 'direct';
  $('fileCount').textContent = directSearch ? '—' : (state.fileCount || 0).toLocaleString('pt-BR');
  $('fileStatLabel').textContent = directSearch ? 'índice ignorado neste modo' : 'arquivos no índice';
  $('rootCount').textContent = directSearch ? directRoots.length : state.roots.length;
  $('rootStatLabel').textContent = directSearch ? 'pastas selecionadas para esta busca' : 'pastas monitoradas';
}

function showIdle(message = 'Digite pelo menos 2 caracteres para pesquisar.') {
  $('resultsBody').innerHTML = '';
  document.querySelector('.table-scroll').classList.add('hidden');
  $('emptyState').classList.remove('hidden');

  const direct = searchMode === 'direct';
  const title = direct
    ? (directRoots.length ? 'Busca direta pronta' : 'Selecione um HD ou pasta')
    : (state.fileCount ? 'Pronto para pesquisar' : 'Nenhum arquivo no índice');
  const description = direct
    ? (directRoots.length ? message : 'Escolha um HD ou pasta e procure quando precisar. Nenhum índice será criado.')
    : (state.fileCount ? message : 'Adicione uma ou mais pastas e clique em “Atualizar catálogo” para começar.');
  const subtitle = direct
    ? message
    : (state.fileCount ? message : 'Adicione pastas e atualize o catálogo para começar.');

  $('emptyState').querySelector('strong').textContent = title;
  $('emptyState').querySelector('span').textContent = description;
  $('resultsSubtitle').textContent = subtitle;
  $('resultCount').textContent = '0';
  $('resultsFootText').textContent = '0 resultados';
}

function classify(ext) {
  if (GEO.has(ext)) return 'geo';
  if (DOC.has(ext)) return 'doc';
  if (TABLE.has(ext)) return 'table';
  return 'other';
}
function renderRows(result) {
  visibleRows = result.rows || [];

  $('resultCount').textContent = result.hasMore
    ? `${visibleRows.length}+`
    : Number(result.total || 0).toLocaleString('pt-BR');

  const query = $('queryInput').value.trim();
  const extension = $('extensionSelect').value;
  const searchLabel = query || extension || 'filtro selecionado';
  const extensionLabel = extension && query ? ` · ${extension}` : '';
  const directLabel = searchMode === 'direct' ? ' · busca direta no HD' : '';
  $('resultsSubtitle').textContent = `Resultados para “${searchLabel}”${extensionLabel}${directLabel}`;

  $('emptyState').classList.toggle('hidden', visibleRows.length > 0);
  document.querySelector('.table-scroll').classList.toggle('hidden', visibleRows.length === 0);

  if (!visibleRows.length) {
    $('emptyState').querySelector('strong').textContent = 'Nenhum arquivo corresponde a esta busca';
    $('emptyState').querySelector('span').textContent = 'Tente outro nome, apelido ou extensão. Confira também se o HD está conectado.';
    $('resultsBody').innerHTML = '';
    $('resultsFootText').textContent = '0 resultados';
    return;
  }

  $('resultsBody').innerHTML = visibleRows.map((file, index) => {
    const extLabel = file.ext === '(sem extensão)' ? 'SEM TIPO' : file.ext.toUpperCase().replace('.', '');
    const category = classify(file.ext);
    const badgeClass = category === 'geo' ? 'geo' : category === 'doc' ? 'doc' : '';
    const references = (file.referenceNames || []).length
      ? `<span class="reference-match">◈ ${esc(file.referenceNames.join(' · '))}</span>`
      : '';

    return `
      <tr data-row="${index}" title="Duplo clique para abrir">
        <td>
          <div class="file-cell">
            <div class="file-icon">${esc(extLabel.slice(0, 4))}</div>
            <div class="file-info">
              <strong>${esc(file.name)}</strong>
              <span>${esc(formatSize(file.size))}</span>
              ${references}
            </div>
          </div>
        </td>
        <td><span class="ext-badge ${badgeClass}">${esc(extLabel)}</span></td>
        <td class="path-cell" title="${esc(file.path)}">${esc(file.directory)}</td>
        <td class="date-cell">${esc(formatDate(file.modified))}</td>
        <td>
          <div class="row-actions">
            <button class="row-action" data-open="${index}" title="Abrir arquivo">Abrir</button>
            <button class="row-action" data-show="${index}" title="Mostrar na pasta">⋯</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  $('resultsBody').querySelectorAll('tr[data-row]').forEach(row => {
    row.addEventListener('dblclick', () => {
      openFile(visibleRows[Number(row.dataset.row)]);
    });
  });

  $('resultsBody').querySelectorAll('[data-open]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      openFile(visibleRows[Number(button.dataset.open)]);
    });
  });

  $('resultsBody').querySelectorAll('[data-show]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      window.buscaGeo.revealPath(visibleRows[Number(button.dataset.show)].path);
    });
  });

  $('resultsFootText').textContent = result.hasMore
    ? `Exibindo os ${visibleRows.length} primeiros; refine a busca para restringir`
    : `${Number(result.total).toLocaleString('pt-BR')} resultado${result.total === 1 ? '' : 's'}`;
}
function scheduleSearch() {
  clearTimeout(searchTimer);
  const sequence = ++searchSequence;
  const query = $('queryInput').value.trim();
  const extension = $('extensionSelect').value;

  if (searchMode === 'direct') {
    if (activeDirectRequest !== null) {
      window.buscaGeo.cancelDirectSearch(activeDirectRequest);
      activeDirectRequest = null;
      $('cancelDirectBtn').classList.add('hidden');
      $('progressArea').classList.add('hidden');
      $('progressPercent').textContent = '';
    }

    const message = directRoots.length
      ? 'Busca direta selecionada. Digite seu termo e clique em “Buscar no HD”; a busca não cria índice.'
      : 'Escolha um HD ou pasta para pesquisar sem indexar.';
    showIdle(message);
    return;
  }

  if (!query && !extension && activeKind === 'all') {
    visibleRows = [];
    showIdle('Digite pelo menos 2 caracteres para pesquisar.');
    return;
  }

  if (query.length === 1 && !extension && activeKind === 'all') {
    visibleRows = [];
    showIdle('Digite mais um caractere para iniciar a busca.');
    return;
  }

  $('resultsSubtitle').textContent = 'Aguardando pesquisa…';
  $('progressArea').classList.remove('hidden');
  $('progressText').textContent = 'Pesquisando no catálogo SQLite/FTS5…';
  $('progressBar').style.width = '40%';
  $('progressPercent').textContent = '';
  searchTimer = setTimeout(() => executeSearch(sequence), 220);
}

async function executeSearch(sequence) {
  if (searchMode === 'direct') {
    await executeDirectSearch();
    return;
  }

  try {
    const result = await window.buscaGeo.searchFiles({
      query: $('queryInput').value.trim(),
      extension: $('extensionSelect').value,
      kind: activeKind,
      sort: $('sortSelect').value
    });

    if (sequence !== searchSequence) return;
    $('progressArea').classList.add('hidden');
    $('progressPercent').textContent = '';

    if (result.scanning) {
      showIdle('Aguarde a atualização do índice terminar para pesquisar.');
      return;
    }

    if (result.needsMoreText) {
      const message = activeKind === 'car'
        ? 'Digite CAR ou um termo para localizar arquivos relacionados.'
        : 'Digite pelo menos 2 caracteres ou escolha uma extensão.';
      showIdle(message);
      return;
    }

    renderRows(result);
  } catch (error) {
    if (sequence === searchSequence) {
      $('progressArea').classList.add('hidden');
      $('progressPercent').textContent = '';
      showToast(`Erro na pesquisa: ${error.message}`);
    }
  }
}
function setSearchMode(mode) {
  if (activeDirectRequest !== null) {
    window.buscaGeo.cancelDirectSearch(activeDirectRequest);
  }

  activeDirectRequest = null;
  $('cancelDirectBtn').classList.add('hidden');
  $('cancelDirectBtn').disabled = false;
  $('progressArea').classList.add('hidden');
  $('progressPercent').textContent = '';

  searchMode = mode;
  const direct = mode === 'direct';

  $('searchModeLabel').textContent = direct
    ? 'Modo atual: busca direta, sem indexação'
    : 'Modo atual: catálogo SQLite/FTS5';
  $('searchModeHelp').textContent = direct
    ? `Pesquisará agora em: ${directRoots.map(basename).join(' · ')}. Não cria nem grava catálogo; clique em “Buscar no HD” para percorrer as pastas.`
    : 'Busca rápida no catálogo local SQLite/FTS5. Atualize o catálogo após adicionar locais ou se o monitoramento estiver desligado.';
  $('directSearchBtn').textContent = direct ? 'Trocar HD/pasta' : 'Buscar direto em HD/pasta';
  $('indexSearchBtn').classList.toggle('hidden', !direct);
  $('searchBtn').textContent = direct ? 'Buscar no HD' : 'Buscar';
  $('fileCount').textContent = direct ? '—' : (state.fileCount || 0).toLocaleString('pt-BR');
  $('fileStatLabel').textContent = direct ? 'índice ignorado neste modo' : 'arquivos no índice';
  $('rootCount').textContent = direct ? directRoots.length : state.roots.length;
  $('rootStatLabel').textContent = direct ? 'pastas selecionadas para esta busca' : 'pastas monitoradas';

  updateExtensionOptions();
  if (direct) {
    $('lastScan').textContent = 'Busca direta sob demanda';
  } else if (state.lastScan) {
    const updatedAt = new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short'
    }).format(new Date(state.lastScan));
    $('lastScan').textContent = `Atualizado em ${updatedAt}`;
  } else {
    $('lastScan').textContent = state.fileCount
      ? 'Índice disponível'
      : 'Índice ainda não atualizado';
  }
  document.querySelector('.pulse').classList.toggle('ok', !direct && Boolean(state.fileCount));

  const message = direct
    ? 'Digite seu termo e clique em “Buscar no HD”.'
    : 'Digite pelo menos 2 caracteres para pesquisar no índice.';
  showIdle(message);
}

async function executeDirectSearch() {
  if (!directRoots.length) {
    showToast('Escolha primeiro um HD ou uma pasta para a busca direta.');
    return;
  }

  const query = $('queryInput').value.trim();
  const extension = $('extensionSelect').value;
  if (query.length === 1 && !extension && activeKind === 'all') {
    showToast('Digite pelo menos 2 caracteres ou selecione uma extensão.');
    return;
  }
  if (!query && !extension && activeKind === 'all') {
    showToast('Digite um termo ou escolha uma extensão/tipo antes de buscar.');
    return;
  }

  if (activeDirectRequest !== null) {
    window.buscaGeo.cancelDirectSearch(activeDirectRequest);
  }

  const requestId = ++directRequestCounter;
  activeDirectRequest = requestId;
  directRows = [];
  visibleRows = [];
  $('cancelDirectBtn').disabled = false;

  $('resultsBody').innerHTML = '';
  document.querySelector('.table-scroll').classList.add('hidden');
  $('emptyState').classList.remove('hidden');
  $('emptyState').querySelector('strong').textContent = 'Percorrendo o HD';
  $('emptyState').querySelector('span').textContent = 'Os primeiros resultados aparecerão durante a busca. Nenhum índice será gravado.';
  $('resultsSubtitle').textContent = `Busca direta em ${directRoots.map(basename).join(', ')}…`;
  $('progressArea').classList.remove('hidden');
  $('progressBar').style.width = '30%';
  $('progressText').textContent = 'Iniciando busca direta…';
  $('progressPercent').textContent = '';
  $('cancelDirectBtn').classList.remove('hidden');

  try {
    const result = await window.buscaGeo.startDirectSearch({
      requestId,
      roots: directRoots,
      query,
      extension,
      kind: activeKind,
      sort: $('sortSelect').value
    });

    if (!result.started && activeDirectRequest === requestId) {
      activeDirectRequest = null;
      $('cancelDirectBtn').classList.add('hidden');
      showToast(result.message || 'Não foi possível iniciar a busca direta.');
    }
  } catch (error) {
    if (activeDirectRequest === requestId) {
      activeDirectRequest = null;
      $('cancelDirectBtn').classList.add('hidden');
      $('progressArea').classList.add('hidden');
      showToast(`Erro na busca direta: ${error.message}`);
    }
  }
}
async function submitChatSearch() {
  const text = $('chatInput').value.trim();
  if (!text) return;

  appendChatMessage('user', text);
  $('chatInput').value = '';
  $('chatInput').style.height = '40px';

  if (activeDirectRequest !== null) {
    window.buscaGeo.cancelDirectSearch(activeDirectRequest);
  }
  if (activeChatRequest !== null) {
    window.buscaGeo.cancelDirectSearch(activeChatRequest);
  }

  activeDirectRequest = null;
  activeChatRequest = null;
  $('chatCancelBtn').classList.add('hidden');
  $('chatCancelBtn').disabled = false;
  $('chatCancelBtn').textContent = 'Parar';

  const requestSequence = ++chatIntentSequence;
  const requestId = `chat-${++chatRequestCounter}`;
  const message = appendChatMessage('assistant', 'Entendendo seu pedido…');
  activeChatMessage = message;
  chatRows = [];
  activeChatRequest = requestId;
  $('chatCancelBtn').classList.remove('hidden');

  const roots = scopeMode === 'computer' ? directRoots : state.roots;
  let contentNotice = '';
  let directSearchStarted = false;

  try {
    if (chatSearchMode === 'content') {
      try {
        const documents = await window.buscaGeo.answerDocuments(text, roots, requestId);
        if (requestSequence !== chatIntentSequence) {
          message.textNode.textContent = 'Esta busca foi substituída por uma mensagem mais recente.';
          return;
        }
        if (documents.cancelled) return;

        if (documents.sources?.length) {
          const answer = documents.source === 'ai'
            ? documents.answer
            : `Encontrei ${documents.sources.length} trecho(s) relacionado(s). Os documentos continuam no computador.${documents.warning ? ` ${documents.warning}` : ''}`;
          addChatResults(message, documents.sources, answer);
          activeChatMessage = null;
          return;
        }

        if (documents.notIndexed) {
          contentNotice = scopeMode === 'computer'
            ? ' O conteúdo deste computador ainda não está no catálogo; adicione os discos em “Pastas/HDs” e clique em “Atualizar catálogo” para habilitar a busca por conteúdo.'
            : ' O conteúdo dos documentos deste escopo ainda não está no catálogo; clique em “Atualizar catálogo” para habilitar essa busca.';
        }
      } catch (error) {
        contentNotice = ` Não consegui pesquisar o conteúdo local (${error.message}); vou tentar pelos nomes dos arquivos.`;
      }
    }

    const interpreted = await window.buscaGeo.interpretSearch(text, requestId);
    if (requestSequence !== chatIntentSequence) {
      message.textNode.textContent = 'Esta busca foi substituída por uma mensagem mais recente.';
      return;
    }
    if (interpreted.cancelled) return;

    const intent = interpreted.intent || {};
    const query = String(intent.query || '').trim();
    const extension = String(intent.extension || '').trim();
    const kind = intent.kind || 'all';
    const modeText = scopeMode === 'computer' ? 'todos os discos locais selecionados' : `${roots.length} pasta(s)/HD(s) adicionados`;
    const termsText = query ? `“${query}”` : 'arquivos que correspondem ao filtro';
    const filtersText = [
      extension && `formato ${extension}`,
      kind !== 'all' && `tipo ${kind}`
    ].filter(Boolean).join(' · ');
    const originText = interpreted.source === 'ai'
      ? `Interpretei com a IA: ${termsText}${filtersText ? ` · ${filtersText}` : ''}.`
      : `Entendi localmente: ${termsText}${filtersText ? ` · ${filtersText}` : ''}.`;
    const searchModeText = chatSearchMode === 'content'
      ? 'Busca por nomes e conteúdo.'
      : 'Busca somente por nomes e caminhos.';
    const warning = `${interpreted.warning ? ` ${interpreted.warning}` : ''}${contentNotice}`;
    if (!query && !extension && kind === 'all') {
      message.textNode.textContent = `Não identifiquei o nome ou tipo do arquivo que você quer. Tente algo como “procure um PDF chamado Antônio Fazendeiro”.${warning}`;
      return;
    }

    if (!roots.length) {
      message.textNode.textContent = `Não há pastas ou HDs no escopo atual. Clique em “Pastas/HDs” para escolher onde pesquisar.${warning}`;
      return;
    }

    if (!state.catalogAvailable && state.catalogError) {
      message.textNode.textContent = `O catálogo rápido não está disponível: ${state.catalogError}. Vou tentar a busca direta.${warning}`;
    } else {
      message.textNode.textContent = `${originText} ${searchModeText} Vou procurar em ${modeText}.${warning}`;
    }

    if (catalogCovers(roots)) {
      message.textNode.textContent = `${originText} ${searchModeText} Pesquisando no catálogo local SQLite/FTS5…${warning}`;
      const indexed = await window.buscaGeo.searchFiles({ query, extension, kind, sort: 'modified', roots });
      if (requestSequence !== chatIntentSequence) return;

      if (indexed.scanning) {
        message.textNode.textContent = 'O catálogo está sendo atualizado. Aguarde a conclusão e tente novamente.';
        if (activeChatMessage === message) activeChatMessage = null;
        return;
      }

      const count = indexed.rows?.length || 0;
      const summary = indexed.error
        ? `Erro no catálogo: ${indexed.error}`
        : count
          ? `Encontrei ${indexed.hasMore ? 'pelo menos ' : ''}${indexed.hasMore ? 250 : count} arquivo(s) no catálogo local. A busca foi feita sem percorrer o HD novamente.${indexed.hasMore ? ' Refine os termos para restringir.' : ''}`
          : 'Não encontrei correspondências no catálogo local. Atualize o catálogo se os arquivos foram acrescentados depois da última varredura.';
      addChatResults(message, indexed.rows || [], summary);
      if (activeChatMessage === message) activeChatMessage = null;
      return;
    }

    if (state.fileCount && scopeMode === 'folders') {
      message.textNode.textContent = `${originText} Este escopo ainda não foi totalmente catalogado; vou percorrê-lo diretamente.${warning}`;
    }

    const started = await window.buscaGeo.startDirectSearch({ requestId, roots, query, extension, kind, sort: 'modified' });
    if (!started.started && activeChatRequest === requestId) {
      message.textNode.textContent = `${started.message || 'Não foi possível iniciar a busca.'}${warning}`;
    } else if (started.started) {
      activeDirectRequest = requestId;
      directSearchStarted = true;
    }
  } catch (error) {
    if (requestSequence === chatIntentSequence) {
      message.textNode.textContent = `Não consegui preparar a busca: ${error.message}`;
    }
  } finally {
    if (!directSearchStarted && activeChatRequest === requestId) {
      activeChatRequest = null;
      activeChatMessage = null;
      $('chatCancelBtn').classList.add('hidden');
      $('chatCancelBtn').disabled = false;
      $('chatCancelBtn').textContent = 'Parar';
    }
  }
}

function cancelChatSearch() {
  if (activeChatRequest === null) return;

  const requestId = activeChatRequest;
  window.buscaGeo.cancelDirectSearch(requestId);
  chatIntentSequence++;

  if (activeChatMessage) {
    if (chatRows.length) addChatResults(activeChatMessage, chatRows, `Busca parada. Encontrei ${chatRows.length} resultado(s) antes do cancelamento.`);
    else activeChatMessage.textNode.textContent = 'Busca cancelada.';
  }

  activeChatMessage = null;
  activeChatRequest = null;
  if (activeDirectRequest === requestId) activeDirectRequest = null;
  $('chatCancelBtn').classList.add('hidden');
  $('chatCancelBtn').disabled = false;
  $('chatCancelBtn').textContent = 'Parar';
}
function setChatSearchMode(mode) {
  chatSearchMode = mode === 'name' ? 'name' : 'content';
  const searchByName = chatSearchMode === 'name';

  $('chatNameModeBtn').classList.toggle('active-mode', searchByName);
  $('chatNameModeBtn').setAttribute('aria-pressed', String(searchByName));
  $('chatContentModeBtn').classList.toggle('active-mode', !searchByName);
  $('chatContentModeBtn').setAttribute('aria-pressed', String(!searchByName));

  $('chatInput').placeholder = searchByName
    ? 'Digite o nome ou caminho do arquivo que procura…'
    : 'Pergunte sobre documentos… Ex.: onde aparece o datum SIRGAS 2000?';
}

function updateChatSearch(payload) {
  if (!activeChatMessage) return;

  if (payload.type === 'progress') {
    const scanned = Number(payload.scanned || 0).toLocaleString('pt-BR');
    activeChatMessage.textNode.textContent = `Estou percorrendo os locais selecionados… ${scanned} itens verificados; ${chatRows.length} resultado(s) encontrado(s) até agora. Você pode parar a busca.`;
    return;
  }

  if (payload.type === 'batch') {
    chatRows.push(...(payload.rows || []));
    const scanned = Number(payload.scanned || 0).toLocaleString('pt-BR');
    activeChatMessage.textNode.textContent = `Busca em andamento… ${scanned} itens examinados; ${chatRows.length} resultado(s) localizado(s).`;
    return;
  }

  if (payload.type === 'done' || payload.type === 'cancelled') {
    const rows = payload.rows || chatRows;
    activeChatRequest = null;
    activeDirectRequest = null;
    $('chatCancelBtn').classList.add('hidden');
    $('chatCancelBtn').disabled = false;
    $('chatCancelBtn').textContent = 'Parar';

    const amount = payload.limitReached ? `pelo menos ${rows.length}` : String(rows.length);
    let summary;
    if (payload.type === 'cancelled') {
      summary = `Busca parada. Encontrei ${rows.length} resultado(s) antes do cancelamento.`;
    } else if (rows.length) {
      summary = `Encontrei ${amount} arquivo(s)${payload.limitReached ? ' — atingi o limite de 250 resultados; refine o nome para restringir.' : '.'}`;
    } else {
      summary = 'Não encontrei arquivos com esses critérios. Tente outro nome, selecione outras pastas ou procure em todo o computador.';
    }

    if (payload.errors) summary += ` Não consegui ler ${payload.errors} pasta(s)/arquivo(s) por falta de acesso ou porque estavam indisponíveis.`;
    addChatResults(activeChatMessage, rows, summary);
    activeChatMessage = null;
    return;
  }

  if (payload.type === 'error') {
    activeChatRequest = null;
    activeDirectRequest = null;
    $('chatCancelBtn').classList.add('hidden');
    $('chatCancelBtn').disabled = false;
    $('chatCancelBtn').textContent = 'Parar';

    if (activeChatMessage) {
      activeChatMessage.textNode.textContent = `A busca não pôde ser concluída: ${payload.message}`;
      activeChatMessage = null;
    }
  }
}
function openAISettings() {
  const config = state.aiConfig || {};
  $('aiBaseUrl').value = config.baseUrl || 'http://localhost:11434/v1';
  $('aiModel').value = config.model || '';
  $('aiApiKey').value = '';
  $('aiClearKey').checked = false;
  $('aiRemoteConsent').checked = Boolean(config.remoteConsent);
  $('aiDocumentConsent').checked = Boolean(config.remoteDocumentConsent);
  $('aiConfigStatus').textContent = config.hasKey
    ? 'Chave já salva criptografada. Deixe o campo vazio para mantê-la.'
    : 'Sem chave salva. Para endpoint remoto é necessária uma chave; para localhost, normalmente não.';
  $('aiSettingsModal').classList.remove('hidden');
  $('aiBaseUrl').focus();
}

function closeAISettings() {
  $('aiSettingsModal').classList.add('hidden');
}

async function saveAISettings(closeAfter = true) {
  try {
    state = await window.buscaGeo.saveAIConfig({
      baseUrl: $('aiBaseUrl').value,
      model: $('aiModel').value,
      apiKey: $('aiApiKey').value,
      clearKey: $('aiClearKey').checked,
      remoteConsent: $('aiRemoteConsent').checked,
      remoteDocumentConsent: $('aiDocumentConsent').checked
    });

    $('aiApiKey').value = '';
    $('aiClearKey').checked = false;
    updateAIStatus();
    $('aiConfigStatus').textContent = state.aiConfig.hasKey
      ? 'Chave salva criptografada pelo sistema operacional.'
      : 'Configuração salva. Se não houver chave, a IA remota ficará inativa.';

    if (closeAfter) {
      closeAISettings();
      showToast('Configuração da IA salva.');
    }
    return true;
  } catch (error) {
    $('aiConfigStatus').textContent = error.message;
    return false;
  }
}

async function testAISettings() {
  if (!await saveAISettings(false)) return;
  $('aiConfigStatus').textContent = 'Testando conexão…';
  $('testAIButton').disabled = true;

  try {
    const result = await window.buscaGeo.testAIConnection();
    $('aiConfigStatus').textContent = result.message;
    showToast(result.message);
  } catch (error) {
    $('aiConfigStatus').textContent = `Falha no teste: ${error.message}`;
  } finally {
    $('testAIButton').disabled = false;
  }
}
function sortDirectRows(rows) {
  const sort = $('sortSelect').value;
  rows.sort((a, b) => sort === 'name' ? norm(a.name).localeCompare(norm(b.name)) : sort === 'path' ? norm(a.path).localeCompare(norm(b.path)) : String(b.modified).localeCompare(String(a.modified)));
  return rows;
}
window.buscaGeo.onDirectSearchUpdate(payload => {
  if (payload.requestId === activeChatRequest) { updateChatSearch(payload); return; }
  if (payload.requestId !== activeDirectRequest) return;
  if (payload.type === 'progress') { $('progressText').textContent = payload.message; return; }
  if (payload.type === 'batch') {
    directRows.push(...(payload.rows || []));
    renderRows({ rows: sortDirectRows(directRows.slice()), total: directRows.length, hasMore: false });
    $('progressText').textContent = `${Number(payload.scanned || 0).toLocaleString('pt-BR')} itens verificados · ${directRows.length} encontrados`;
    return;
  }
  if (payload.type === 'done' || payload.type === 'cancelled') {
    directRows = payload.rows || directRows; activeDirectRequest = null; $('cancelDirectBtn').classList.add('hidden'); $('cancelDirectBtn').disabled = false; $('progressArea').classList.add('hidden'); $('progressPercent').textContent = '';
    renderRows({ rows: directRows, total: payload.matches || directRows.length, hasMore: Boolean(payload.limitReached) });
    if (payload.type === 'cancelled') $('resultsSubtitle').textContent = `Busca cancelada após examinar ${Number(payload.scanned || 0).toLocaleString('pt-BR')} itens.`;
    else $('resultsSubtitle').textContent = `${payload.message}${payload.errors ? ` · ${payload.errors} pasta(s)/arquivo(s) sem acesso` : ''}`;
    return;
  }
  if (payload.type === 'error') { activeDirectRequest = null; $('cancelDirectBtn').classList.add('hidden'); $('cancelDirectBtn').disabled = false; $('progressArea').classList.add('hidden'); $('progressPercent').textContent = ''; showToast(payload.message); }
});

async function openFile(file) {
  const error = await window.buscaGeo.openPath(file.path);
  if (error) showToast(`Não foi possível abrir: ${error}`);
}

function refreshAll() {
  renderRootsAndStats();
  scheduleSearch();
}

function openReference(ref = null) {
  $('referenceForm').reset(); $('refId').value = ref?.id || ''; $('refTitle').value = ref?.title || ''; $('refNames').value = (ref?.names || []).join('; '); $('refPath').value = ref?.path || ''; $('refNotes').value = ref?.notes || ''; $('modalTitle').textContent = ref ? 'Editar referência' : 'Cadastrar referência';
  $('referenceModal').classList.remove('hidden'); $('refTitle').focus();
}

function closeModal() {
  $('referenceModal').classList.add('hidden');
}
$('addFoldersBtn').addEventListener('click', async () => { state.roots = await window.buscaGeo.selectFolders(); renderRootsAndStats(); showToast('Pastas adicionadas ao escopo de busca da conversa.'); });
$('addFoldersBtn2').addEventListener('click', () => $('addFoldersBtn').click());
$('chatFoldersBtn').addEventListener('click', async () => { state.roots = await window.buscaGeo.selectFolders(); scopeMode = 'folders'; directRoots = state.roots.slice(); renderRootsAndStats(); updateChatScope(); appendChatMessage('assistant', state.roots.length ? `Pronto. Vou procurar nas ${state.roots.length} pasta(s)/HD(s) adicionados. Você pode escrever o nome do arquivo agora.` : 'Ainda não há pastas selecionadas. Use “＋ Adicionar pasta ou HD” na lateral para escolher os locais.'); });
$('chatComputerBtn').addEventListener('click', async () => { $('chatComputerBtn').disabled = true; $('chatComputerBtn').textContent = 'Localizando unidades…'; try { const roots = await window.buscaGeo.getComputerRoots(); if (!roots.length) { showToast('Não encontrei discos locais disponíveis.'); return; } scopeMode = 'computer'; directRoots = roots; updateChatScope(); appendChatMessage('assistant', `Escopo alterado para todas as unidades locais detectadas (${roots.map(basename).join(', ')}). A busca percorre arquivos e subpastas e pode demorar; use “Parar” para cancelar.`); } catch (error) { showToast(`Não foi possível listar unidades: ${error.message}`); } finally { $('chatComputerBtn').disabled = false; $('chatComputerBtn').textContent = 'Todo o computador'; } });
$('chatForm').addEventListener('submit', event => { event.preventDefault(); submitChatSearch(); });
$('chatNameModeBtn').addEventListener('click', () => setChatSearchMode('name'));
$('chatContentModeBtn').addEventListener('click', () => setChatSearchMode('content'));
$('chatInput').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('chatForm').requestSubmit(); } });
$('chatInput').addEventListener('input', () => { $('chatInput').style.height = '40px'; $('chatInput').style.height = `${Math.min($('chatInput').scrollHeight, 120)}px`; });
$('chatCancelBtn').addEventListener('click', cancelChatSearch);
$('chatClearBtn').addEventListener('click', () => {
  if (activeChatRequest !== null) { window.buscaGeo.cancelDirectSearch(activeChatRequest); chatIntentSequence++; activeChatRequest = null; }
  if (activeDirectRequest !== null) { window.buscaGeo.cancelDirectSearch(activeDirectRequest); activeDirectRequest = null; }
  activeChatMessage = null; chatRows = []; $('chatCancelBtn').classList.add('hidden'); $('chatCancelBtn').disabled = false; $('chatCancelBtn').textContent = 'Parar';
  const messages = $('chatMessages');
  messages.innerHTML = '';
  const welcome = document.createElement('div'); welcome.className = 'chat-row assistant';
  const bubble = document.createElement('div'); bubble.className = 'chat-bubble';
  const text = document.createElement('div'); text.className = 'chat-message-text';
  text.innerHTML = 'Conversa limpa. Diga o que você quer encontrar.<br><br>Exemplo: <strong>“Em qual documento aparece o CAR da Fazenda Santa Luzia?”</strong>';
  const meta = document.createElement('div'); meta.className = 'chat-meta'; meta.textContent = 'BuscaGeo · agora';
  bubble.append(text, meta); welcome.appendChild(bubble); messages.appendChild(welcome);
  showToast('Conversa limpa.');
});
$('aiSettingsBtn').addEventListener('click', openAISettings); $('closeAISettings').addEventListener('click', closeAISettings); $('cancelAISettings').addEventListener('click', closeAISettings);
$('dashscopePreset').addEventListener('click', () => {
  $('aiBaseUrl').value = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  $('aiModel').value = 'qwen3-vl-235b-a22b-instruct';
});
$('aiSettingsModal').addEventListener('click', event => { if (event.target === $('aiSettingsModal')) closeAISettings(); });
$('aiSettingsForm').addEventListener('submit', async event => { event.preventDefault(); await saveAISettings(true); });
$('testAIButton').addEventListener('click', testAISettings);
$('referenceBtn').addEventListener('click', () => openReference()); $('referenceBtn2').addEventListener('click', () => openReference());
$('closeModal').addEventListener('click', closeModal); $('cancelModal').addEventListener('click', closeModal);
$('referenceModal').addEventListener('click', event => { if (event.target === $('referenceModal')) closeModal(); });
$('chooseRefFolder').addEventListener('click', async () => { const folder = await window.buscaGeo.selectReferenceFolder(); if (folder) $('refPath').value = folder; });
$('referenceForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const ref = { id: $('refId').value || undefined, title: $('refTitle').value, names: $('refNames').value.split(';'), path: $('refPath').value, notes: $('refNotes').value };
    await window.buscaGeo.saveReference(ref); closeModal(); state = await window.buscaGeo.loadState(); renderRootsAndStats(); scheduleSearch(); showToast('Referência salva.');
  } catch (error) { showToast(error.message || 'Não foi possível salvar a referência.'); }
});
$('scanBtn').addEventListener('click', async () => {
  if (!state.roots.length) { showToast('Adicione primeiro a pasta do escritório ou um HD.'); return; }
  $('scanBtn').disabled = true; $('scanBtn').textContent = 'Catalogando…'; $('cancelScanBtn').classList.remove('hidden'); $('cancelScanBtn').disabled = false; $('progressArea').classList.remove('hidden'); $('progressText').textContent = 'Iniciando catalogação…'; $('progressPercent').textContent = '0%'; $('progressBar').style.width = '0%';
  try {
    const result = await window.buscaGeo.scan();
    if (result.started && result.incremental) { state = await window.buscaGeo.loadState(); renderRootsAndStats(); $('progressText').textContent = 'Monitoramento ativo: o catálogo já recebeu as mudanças; nenhuma varredura completa foi necessária.'; $('progressBar').style.width = '100%'; $('progressPercent').textContent = 'Atualizado'; showToast(`${state.fileCount.toLocaleString('pt-BR')} arquivos no catálogo. Nenhuma varredura completa foi necessária.`); scheduleSearch(); }
    else if (result.started && result.cancelled) { state = await window.buscaGeo.loadState(); renderRootsAndStats(); $('progressText').textContent = 'Atualização cancelada; os itens já processados foram preservados.'; $('progressPercent').textContent = ''; }
    else if (result.started) { state = await window.buscaGeo.loadState(); renderRootsAndStats(); $('progressText').textContent = `${result.total.toLocaleString('pt-BR')} arquivos verificados nesta atualização${result.rootsOffline ? ` · ${result.rootsOffline} HD(s) offline; dados preservados` : ''} · ${state.fileCount.toLocaleString('pt-BR')} no catálogo${result.documentErrors ? ` · ${result.documentErrors} documento(s) sem texto extraível` : ''}${state.keepIndex ? ' · salvo entre sessões' : ' · temporário'}`; $('progressBar').style.width = '100%'; $('progressPercent').textContent = '100%'; showToast(`${state.fileCount.toLocaleString('pt-BR')} arquivos no catálogo SQLite.${result.documentErrors ? ` ${result.documentErrors} documento(s) não puderam ser extraídos.` : ''}`); scheduleSearch(); }
    else if (result.message) { showToast(result.message); }
  } catch (error) { showToast(`Erro ao atualizar índice: ${error.message}`); }
  finally { $('scanBtn').disabled = false; $('scanBtn').textContent = '⟳ Atualizar catálogo'; $('cancelScanBtn').classList.add('hidden'); $('cancelScanBtn').disabled = false; setTimeout(() => $('progressArea').classList.add('hidden'), 4500); }
});
$('cancelScanBtn').addEventListener('click', async () => {
  $('cancelScanBtn').disabled = true; $('progressText').textContent = 'Cancelando atualização…';
  try {
    if (!await window.buscaGeo.cancelScan()) { $('cancelScanBtn').classList.add('hidden'); $('progressText').textContent = 'A atualização já foi concluída.'; }
  } catch (error) {
    $('cancelScanBtn').disabled = false; showToast(`Não foi possível cancelar a atualização: ${error.message}`);
  }
});
window.buscaGeo.onScanProgress(progress => {
  if (progress.phase === 'scan') {
    $('progressArea').classList.remove('hidden');
    $('progressText').textContent = progress.message;
    const pct = typeof progress.percent === 'number' ? progress.percent : (progress.estimatedTotal ? Math.min(95, Math.round((progress.scanned / progress.estimatedTotal) * 100)) : 5);
    $('progressBar').style.width = `${pct}%`;
    $('progressPercent').textContent = `${pct}%`;
  } else if (progress.phase === 'root' || progress.phase === 'root-start') {
    $('progressText').textContent = progress.message || `${basename(progress.root)} — verificando pasta/HD.`;
    if (typeof progress.percent === 'number') { $('progressBar').style.width = `${progress.percent}%`; $('progressPercent').textContent = `${progress.percent}%`; }
  } else if (progress.phase === 'document-warning') {
    $('progressText').textContent = progress.message;
  } else if (progress.phase === 'watch') {
    $('watchStatus').textContent = progress.message;
    if (progress.fileCount !== undefined) { state.fileCount = Number(progress.fileCount); if (searchMode !== 'direct') $('fileCount').textContent = state.fileCount.toLocaleString('pt-BR'); }
  } else if (progress.phase === 'done') {
    const elapsed = progress.elapsedSeconds ? ` · concluído em ${formatElapsed(progress.elapsedSeconds)}` : '';
    $('progressText').textContent = progress.incremental ? 'Monitoramento ativo: o catálogo já recebeu as mudanças; nenhuma varredura completa foi necessária.' : `Catalogação concluída.${elapsed}`;
    $('progressBar').style.width = '100%'; $('progressPercent').textContent = '100%';
    state.fileCount = Number(progress.fileCount ?? state.fileCount);
    state.catalogRoots = progress.catalogRoots || state.catalogRoots;
  } else if (progress.phase === 'cancelled') {
    $('progressText').textContent = progress.message || 'Atualização cancelada.';
    $('cancelScanBtn').classList.add('hidden'); $('cancelScanBtn').disabled = false;
  } else if (progress.phase === 'error') {
    $('progressText').textContent = progress.message;
  }
});
$('queryInput').addEventListener('input', scheduleSearch); $('extensionSelect').addEventListener('change', scheduleSearch); $('sortSelect').addEventListener('change', scheduleSearch);
$('directSearchBtn').addEventListener('click', async () => { const selected = await window.buscaGeo.selectDirectFolders(); if (selected.length) { directRoots = selected; setSearchMode('direct'); showToast('Busca direta ativada. Digite um termo e clique em “Buscar no HD”. Nenhum catálogo será gravado.'); } });
$('indexSearchBtn').addEventListener('click', () => { setSearchMode('index'); scheduleSearch(); });
$('cancelDirectBtn').addEventListener('click', () => { if (activeDirectRequest !== null) { window.buscaGeo.cancelDirectSearch(activeDirectRequest); $('cancelDirectBtn').disabled = true; $('progressText').textContent = 'Cancelando busca direta…'; } });
$('searchBtn').addEventListener('click', () => { clearTimeout(searchTimer); executeSearch(++searchSequence); });
$('queryInput').addEventListener('keydown', event => { if (event.key === 'Enter') { clearTimeout(searchTimer); executeSearch(++searchSequence); } });
$('clearSearch').addEventListener('click', () => { $('queryInput').value = ''; $('extensionSelect').value = ''; activeKind = 'all'; document.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.kind === 'all')); scheduleSearch(); });
document.querySelectorAll('.filter-chip').forEach(chip => chip.addEventListener('click', () => {
  activeKind = chip.dataset.kind; document.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c === chip));
  if (activeKind === 'car') { $('queryInput').value = 'CAR'; $('extensionSelect').value = ''; } else if (activeKind !== 'all') { $('queryInput').value = ''; $('extensionSelect').value = ''; }
  scheduleSearch();
}));
$('exportBtn').addEventListener('click', async () => { if (!visibleRows.length) { showToast('Não há resultados para exportar.'); return; } const file = await window.buscaGeo.exportCsv(visibleRows); if (file) showToast(`Resultados exibidos exportados: ${basename(file)}`); });
$('deleteLegacyIndexButton').addEventListener('click', async () => {
  if (!state.legacyIndexExists || !confirm('Apagar o catálogo antigo salvo pelo BuscaGeo? Isso remove somente o índice de nomes e caminhos. Os arquivos originais, pastas e referências não serão alterados.')) return;
  try { state = await window.buscaGeo.deleteLegacyIndex(); renderRootsAndStats(); showToast('Catálogo JSON antigo apagado. O catálogo SQLite e os arquivos originais não foram alterados.'); }
  catch (error) { showToast(`Não foi possível apagar o catálogo: ${error.message}`); }
});
$('keepIndexToggle').addEventListener('change', async () => {
  const keep = $('keepIndexToggle').checked;
  if (!keep && state.keepIndex && state.fileCount && !confirm('Desativar a persistência do catálogo? O banco temporário será apagado ao fechar o BuscaGeo. Os arquivos originais não serão alterados.')) { $('keepIndexToggle').checked = true; return; }
  $('retentionStatus').textContent = keep ? 'Marcando catálogo para persistir…' : 'O catálogo ficará temporário nesta sessão…';
  try { state = await window.buscaGeo.setKeepIndex(keep); renderRootsAndStats(); showToast(keep ? 'O catálogo SQLite será mantido entre sessões.' : 'O catálogo será apagado ao fechar o aplicativo.'); }
  catch (error) { $('keepIndexToggle').checked = state.keepIndex; showToast(`Não foi possível alterar a preferência: ${error.message}`); }
});
$('watchIndexToggle').addEventListener('change', async () => {
  try { state = await window.buscaGeo.setWatchEnabled($('watchIndexToggle').checked); renderRootsAndStats(); showToast(state.watchEnabled ? 'Monitoramento das pastas ativado.' : 'Monitoramento das pastas desativado.'); }
  catch (error) { $('watchIndexToggle').checked = state.watchEnabled; showToast(`Não foi possível configurar o monitoramento: ${error.message}`); }
});
window.addEventListener('keydown', event => { if (event.key === 'Escape') { closeModal(); closeAISettings(); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); $('chatInput').focus(); } });
(async () => { state = await window.buscaGeo.loadState(); directRoots = state.roots.slice(); renderRootsAndStats(); updateAIStatus(); updateChatScope(); showIdle(state.fileCount ? 'Digite pelo menos 2 caracteres para pesquisar.' : 'Adicione uma ou mais pastas e clique em “Atualizar catálogo”.'); })();

// Exclusão afeta apenas o cadastro de apelidos, nunca os arquivos indexados.
const openReferenceOriginal = openReference;
openReference = function (ref = null) {
  openReferenceOriginal(ref);
  let button = document.getElementById('deleteRefButton');
  if (!button) {
    button = document.createElement('button'); button.id = 'deleteRefButton'; button.type = 'button'; button.className = 'button button-light'; button.textContent = 'Excluir referência'; button.style.cssText = 'margin-right:auto;color:#a14b4b';
    document.querySelector('.modal-actions').prepend(button);
    button.addEventListener('click', async () => { const id = $('refId').value; if (!id || !confirm('Excluir esta referência? Os arquivos e pastas não serão alterados.')) return; await window.buscaGeo.deleteReference(id); closeModal(); state = await window.buscaGeo.loadState(); renderRootsAndStats(); scheduleSearch(); showToast('Referência excluída. Nenhum arquivo foi alterado.'); });
  }
  button.classList.toggle('hidden', !ref);
};
