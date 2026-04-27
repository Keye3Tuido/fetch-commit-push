// ============================================================
// GitHub File Manager - app.js
// Pending changes model: all edits are local until commit & push
// ============================================================

const STORAGE_KEY = 'ghfm_config';
let allRepos = [];
let allBranches = [];
let treeData = [];        // flat list from remote: {path, type, sha}
let currentFile = null;   // {path, sha, originalContent}
let expandedDirs = new Set();

// Pending changes map: path -> { type: 'M'|'A'|'D'|'R', content?, oldPath?, originalSha? }
const pendingChanges = new Map();

const csFlags = { repo: false, branch: false, file: false };

function toggleCs(key) {
  csFlags[key] = !csFlags[key];
  document.getElementById(key + '-cs').classList.toggle('active', csFlags[key]);
  if (key === 'repo') renderRepoList(document.getElementById('repo-input').value);
  else if (key === 'branch') renderBranchList(document.getElementById('branch-input').value);
  else if (key === 'file') {
    const q = document.getElementById('file-search').value.trim();
    if (q) doFileSearch(q);
  }
}

function matchFilter(text, query, cs) {
  if (!query) return true;
  return cs ? text.includes(query) : text.toLowerCase().includes(query.toLowerCase());
}

// ---- File/folder name validation ----
const INVALID_NAME_CHARS = /[\\:*?"<>|]/;
const INVALID_NAMES = /^\.+$/; // pure dots like "." or ".."
function validateName(name) {
  if (!name) return '名称不能为空';
  if (INVALID_NAME_CHARS.test(name)) return '名称不能包含 \\ : * ? " < > |';
  if (name !== name.trim()) return '名称不能以空格开头或结尾';
  if (INVALID_NAMES.test(name)) return '名称不能是 . 或 ..';
  if (name.includes('/')) return '名称不能包含 /';
  if (name.length > 255) return '名称不能超过 255 个字符';
  return null;
}
function validatePath(path) {
  if (!path) return '路径不能为空';
  const parts = path.split('/');
  for (const p of parts) {
    const err = validateName(p);
    if (err) return `"${p}": ${err}`;
  }
  return null;
}

// ---- Config (token stored in sessionStorage for security) ----
function getConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    stored.token = sessionStorage.getItem('ghfm_token') || stored.token || '';
    return stored;
  } catch { return {}; }
}
function setConfig(c) {
  sessionStorage.setItem('ghfm_token', c.token || '');
  const toStore = { ...c }; delete toStore.token;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
}
function readInputs() {
  return {
    token: document.getElementById('token-input').value.trim(),
    user: document.getElementById('user-input').value.trim(),
    repo: document.getElementById('repo-input').value.trim(),
    branch: document.getElementById('branch-input').value.trim(),
  };
}
function persistInputs() { setConfig(readInputs()); }
function fullRepo() {
  const c = readInputs();
  if (c.repo.includes('/')) return c.repo;
  return c.user && c.repo ? c.user + '/' + c.repo : c.repo;
}

(function init() {
  const c = getConfig();
  document.getElementById('token-input').value = c.token || '';
  document.getElementById('user-input').value = c.user || '';
  document.getElementById('repo-input').value = c.repo || '';
  document.getElementById('branch-input').value = c.branch || '';
  // Auto-load if token and user are cached
  if (c.token && c.user) {
    setTimeout(() => loadRepos(), 100);
  }
})();

function toggleTokenVisibility() {
  const el = document.getElementById('token-input');
  el.type = el.type === 'password' ? 'text' : 'password';
}

// ---- Status ----
function setStatus(msg, right) {
  document.getElementById('status-left').textContent = msg;
  if (right !== undefined) document.getElementById('status-right').textContent = right;
}

// ---- GitHub API ----
async function ghApi(method, path, body) {
  const c = readInputs();
  if (!c.token) throw new Error('请先输入 Token');
  const opts = { method, headers: { 'Authorization': 'token ' + c.token, 'Accept': 'application/vnd.github+json' } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch('https://api.github.com' + path, opts);
  if (r.status === 404) throw new Error('未找到: ' + path);
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(`API ${r.status}: ${e.message || r.statusText}`); }
  if (r.status === 204) return null;
  return r.json();
}
async function ghApiFetchAll(path) {
  const results = []; let page = 1; const MAX_PAGES = 50;
  while (page <= MAX_PAGES) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await ghApi('GET', `${path}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

// ============================================================
// Unified pending change management
// All writes to pendingChanges go through these functions.
// stageFile compares content with remote to determine A/M/skip.
// Uses Git blob SHA for comparison — the same way Git itself works.
// ============================================================

async function fetchRemoteContent(filePath) {
  const repo = fullRepo(); const c = readInputs();
  return await ghApi('GET', `/repos/${repo}/contents/${filePath}?ref=${c.branch}`);
}

/**
 * Compute the Git blob SHA1 for given content.
 * Git blob = "blob <size>\0<content>" then SHA-1.
 */
async function gitBlobSha(contentBytes) {
  const header = new TextEncoder().encode('blob ' + contentBytes.length + '\0');
  const combined = new Uint8Array(header.length + contentBytes.length);
  combined.set(header);
  combined.set(contentBytes, header.length);
  const hashBuffer = await crypto.subtle.digest('SHA-1', combined);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Stage a file change. Compares with remote SHA to decide type (A/M/skip).
 * @param {string} filePath
 * @param {string} content - text content or base64 string for binary
 * @param {object} [opts] - { binary: bool }
 * @returns {'A'|'M'|'skip'} the action taken
 */
async function stageFile(filePath, content, opts = {}) {
  const binary = !!opts.binary;
  const remoteEntry = treeData.find(i => i.type === 'file' && i.path === filePath);

  if (!remoteEntry) {
    pendingChanges.set(filePath, binary
      ? { type: 'A', content, binary: true }
      : { type: 'A', content });
    return 'A';
  }

  // Compare using Git blob SHA
  try {
    const contentBytes = binary
      ? Uint8Array.from(atob(content), c => c.charCodeAt(0))
      : new TextEncoder().encode(content.replace(/\r\n/g, '\n'));
    const localSha = await gitBlobSha(contentBytes);

    if (localSha === remoteEntry.sha) {
      pendingChanges.delete(filePath);
      return 'skip';
    }
    pendingChanges.set(filePath, binary
      ? { type: 'M', content, binary: true, originalSha: remoteEntry.sha }
      : { type: 'M', content, originalSha: remoteEntry.sha });
    return 'M';
  } catch {
    // SHA computation failed, fall back to treating as modified
    pendingChanges.set(filePath, binary
      ? { type: 'M', content, binary: true, originalSha: remoteEntry.sha }
      : { type: 'M', content, originalSha: remoteEntry.sha });
    return 'M';
  }
}

function stageDelete(filePath) {
  if (pendingChanges.has(filePath) && pendingChanges.get(filePath).type === 'A') {
    pendingChanges.delete(filePath);
  } else {
    pendingChanges.set(filePath, { type: 'D' });
  }
}

// ============================================================
// Repo & Branch combos (unchanged logic)
// ============================================================
async function loadRepos() {
  persistInputs(); const c = readInputs();
  if (!c.token || !c.user) { setStatus('请填写 Token 和用户名'); return; }
  const btn = document.getElementById('load-repos-btn');
  btn.disabled = true; btn.textContent = '加载中…';
  setStatus('正在加载仓库列表…');
  try {
    const isAuthUser = await ghApi('GET', '/user').then(u => u.login.toLowerCase() === c.user.toLowerCase()).catch(() => false);
    const endpoint = isAuthUser ? '/user/repos?affiliation=owner' : `/users/${c.user}/repos`;
    const data = await ghApiFetchAll(endpoint);
    allRepos = data.map(r => r.name).sort((a, b) => a.localeCompare(b));
    setStatus(`已加载 ${allRepos.length} 个仓库`, c.user);
    renderRepoList(''); openCombo('repo');
    // Auto-load branches if repo is already filled
    if (c.repo && allRepos.includes(c.repo)) await loadBranches();
  } catch (e) { setStatus('加载仓库失败: ' + e.message); allRepos = []; }
  finally { btn.disabled = false; btn.textContent = '加载账号'; }
}
function renderRepoList(filter) {
  const list = document.getElementById('repo-list'); list.innerHTML = '';
  const cur = document.getElementById('repo-input').value.trim();
  const filtered = allRepos.filter(r => matchFilter(r, filter, csFlags.repo));
  if (!allRepos.length) { list.innerHTML = '<div class="combo-empty">请先加载仓库</div>'; return; }
  if (!filtered.length) { list.innerHTML = '<div class="combo-empty">无匹配仓库</div>'; return; }
  for (const name of filtered) {
    const d = document.createElement('div');
    d.className = 'combo-item' + (name === cur ? ' active' : '');
    d.textContent = name;
    d.addEventListener('mousedown', e => { e.preventDefault(); selectRepo(name); });
    list.appendChild(d);
  }
}
function selectRepo(name) {
  document.getElementById('repo-input').value = name;
  closeCombo('repo'); persistInputs(); loadBranches();
}
document.getElementById('repo-input').addEventListener('focus', () => { renderRepoList(document.getElementById('repo-input').value); openCombo('repo'); });
document.getElementById('repo-input').addEventListener('input', e => { renderRepoList(e.target.value); openCombo('repo'); });
document.getElementById('repo-input').addEventListener('blur', () => setTimeout(() => closeCombo('repo'), 150));
document.getElementById('repo-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); closeCombo('repo'); persistInputs(); loadBranches(); }
  if (e.key === 'Escape') closeCombo('repo');
});
document.getElementById('user-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); loadRepos(); } });

async function loadBranches() {
  persistInputs(); const repo = fullRepo();
  if (!readInputs().token || !repo || !repo.includes('/')) { setStatus('请填写 Token 并选择仓库'); return; }
  setStatus('正在加载分支列表…');
  try {
    const data = await ghApiFetchAll(`/repos/${repo}/branches`);
    allBranches = data.map(b => b.name);
    setStatus(`已加载 ${allBranches.length} 个分支`, repo);
    renderBranchList(''); openCombo('branch');
    const c = readInputs();
    if (c.branch && !allBranches.includes(c.branch)) {
      document.getElementById('branch-input').value = '';
    } else if (c.branch && allBranches.includes(c.branch)) {
      // Auto-load tree if branch is already filled and valid
      closeCombo('branch');
      await loadTree();
    }
  } catch (e) { setStatus('加载分支失败: ' + e.message); allBranches = []; }
}
function renderBranchList(filter) {
  const list = document.getElementById('branch-list'); list.innerHTML = '';
  const cur = document.getElementById('branch-input').value.trim();
  const filtered = allBranches.filter(b => matchFilter(b, filter, csFlags.branch));
  if (!allBranches.length) { list.innerHTML = '<div class="combo-empty">请先加载分支</div>'; return; }
  if (!filtered.length) { list.innerHTML = '<div class="combo-empty">无匹配分支</div>'; return; }
  for (const name of filtered) {
    const d = document.createElement('div');
    d.className = 'combo-item' + (name === cur ? ' active' : '');
    d.textContent = name;
    d.addEventListener('mousedown', e => { e.preventDefault(); selectBranch(name); });
    list.appendChild(d);
  }
}
function selectBranch(name) {
  document.getElementById('branch-input').value = name;
  closeCombo('branch'); persistInputs(); loadTree();
}
document.getElementById('branch-input').addEventListener('focus', () => { renderBranchList(document.getElementById('branch-input').value); openCombo('branch'); });
document.getElementById('branch-input').addEventListener('input', e => { renderBranchList(e.target.value); openCombo('branch'); });
document.getElementById('branch-input').addEventListener('blur', () => setTimeout(() => closeCombo('branch'), 150));
document.getElementById('branch-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); closeCombo('branch'); if (e.target.value.trim()) { persistInputs(); loadTree(); } }
  if (e.key === 'Escape') closeCombo('branch');
});
function openCombo(id) {
  const combo = document.getElementById(id + '-combo');
  combo.classList.add('open');
  // Position dropdown on mobile
  if (window.innerWidth <= 768) {
    const input = combo.querySelector('.combo-input');
    const rect = input.getBoundingClientRect();
    const list = document.getElementById(id + '-list');
    list.style.top = rect.bottom + 'px';
  }
}
function closeCombo(id) {
  document.getElementById(id + '-combo').classList.remove('open');
}

// Close all combos when clicking outside
document.addEventListener('click', e => {
  for (const id of ['repo', 'branch']) {
    const combo = document.getElementById(id + '-combo');
    if (combo && !combo.contains(e.target)) closeCombo(id);
  }
});

// ============================================================
// File tree
// ============================================================
async function loadTree() {
  persistInputs(); const c = readInputs(); const repo = fullRepo();
  if (!c.token || !repo || !c.branch) { setStatus('请填写 Token、仓库和分支'); return; }
  if (pendingChanges.size > 0 && !confirm('有未提交的变更，切换分支将丢失。继续？')) return;
  setStatus('正在加载文件树…');
  treeData = []; expandedDirs.clear(); currentFile = null; pendingChanges.clear();
  closeEditor(); renderChanges();
  try {
    const data = await ghApi('GET', `/repos/${repo}/git/trees/${c.branch}?recursive=1`);
    treeData = data.tree.filter(i => i.type === 'blob' || i.type === 'tree')
      .map(i => ({ path: i.path, type: i.type === 'tree' ? 'dir' : 'file', sha: i.sha }));
    renderTree();
    setStatus(`已加载 ${treeData.length} 个项目`, `${repo} @ ${c.branch}`);
  } catch (e) { setStatus('加载失败: ' + e.message); document.getElementById('tree').innerHTML = ''; }
}

function buildTreeStructure() {
  const root = { name: '', children: [], type: 'dir', path: '' };
  const dirMap = { '': root };
  for (const item of treeData) {
    if (item.type === 'dir') {
      const parts = item.path.split('/'); let cur = '';
      for (const p of parts) {
        const par = cur; cur = cur ? cur + '/' + p : p;
        if (!dirMap[cur]) { const n = { name: p, children: [], type: 'dir', path: cur, sha: item.sha }; dirMap[cur] = n; dirMap[par].children.push(n); }
      }
    }
  }
  for (const item of treeData) {
    if (item.type === 'file') {
      const parts = item.path.split('/'); const fn = parts.pop(); const pp = parts.join('/');
      if (!dirMap[pp]) { let cur = ''; for (const p of parts) { const prev = cur; cur = cur ? cur + '/' + p : p; if (!dirMap[cur]) { const n = { name: p, children: [], type: 'dir', path: cur }; dirMap[cur] = n; dirMap[prev].children.push(n); } } }
      dirMap[pp].children.push({ name: fn, type: 'file', path: item.path, sha: item.sha });
    }
  }
  // Also add pending new files to tree
  const treeFilePaths = new Set(treeData.filter(i => i.type === 'file').map(i => i.path));
  for (const [path, ch] of pendingChanges) {
    if (ch.type === 'A' && !treeFilePaths.has(path)) {
      const parts = path.split('/'); const fn = parts.pop(); const pp = parts.join('/');
      if (!dirMap[pp]) { let cur = ''; for (const p of parts) { const prev = cur; cur = cur ? cur + '/' + p : p; if (!dirMap[cur]) { const n = { name: p, children: [], type: 'dir', path: cur }; dirMap[cur] = n; dirMap[prev].children.push(n); } } }
      const parent = dirMap[pp];
      if (parent) {
        parent.children.push({ name: fn, type: 'file', path, sha: null });
      }
    }
  }
  function sortChildren(n) { if (n.children) { n.children.sort((a, b) => { if (a.type !== b.type) return a.type === 'dir' ? -1 : 1; return a.name.localeCompare(b.name); }); n.children.forEach(sortChildren); } }
  sortChildren(root);
  return root;
}

function renderTree() {
  const root = buildTreeStructure();
  const container = document.getElementById('tree'); container.innerHTML = '';
  renderTreeNodes(root.children, container, 0);
}

function renderTreeNodes(nodes, container, depth) {
  for (const node of nodes) {
    // Skip deleted files
    if (node.type === 'file' && pendingChanges.has(node.path) && pendingChanges.get(node.path).type === 'D') continue;

    const div = document.createElement('div');
    div.className = 'tree-item' + (currentFile && currentFile.path === node.path ? ' selected' : '');
    for (let i = 0; i < depth; i++) { const s = document.createElement('span'); s.className = 'indent'; div.appendChild(s); }

    if (node.type === 'dir') {
      const t = document.createElement('span'); t.className = 'tree-toggle'; t.textContent = expandedDirs.has(node.path) ? '▼' : '▶'; div.appendChild(t);
      const ic = document.createElement('span'); ic.className = 'icon'; ic.textContent = expandedDirs.has(node.path) ? '📂' : '📁'; div.appendChild(ic);
    } else {
      const s = document.createElement('span'); s.className = 'tree-toggle'; div.appendChild(s);
      const ic = document.createElement('span'); ic.className = 'icon'; ic.textContent = getFileIcon(node.name); div.appendChild(ic);
    }

    const nameSpan = document.createElement('span'); nameSpan.className = 'name'; nameSpan.textContent = node.name; div.appendChild(nameSpan);

    // Change badge
    if (node.type === 'file' && pendingChanges.has(node.path)) {
      const ch = pendingChanges.get(node.path);
      const badge = document.createElement('span');
      badge.className = 'change-badge ' + (ch.type === 'M' ? 'modified' : ch.type === 'A' ? 'added' : 'deleted');
      badge.textContent = ch.type;
      div.appendChild(badge);
    }

    div.addEventListener('click', () => onTreeItemClick(node));
    div.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e, node); });
    container.appendChild(div);

    if (node.type === 'dir' && expandedDirs.has(node.path) && node.children) {
      renderTreeNodes(node.children, container, depth + 1);
    }
  }
}

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const m = { js:'📜',ts:'📘',py:'🐍',html:'🌐',css:'🎨',json:'📋',md:'📝',txt:'📄',yml:'⚙️',yaml:'⚙️',sh:'🔧',xml:'📰',svg:'🖼️',png:'🖼️',jpg:'🖼️',gif:'🖼️',ico:'🖼️' };
  return m[ext] || '📄';
}

function onTreeItemClick(node) {
  if (node.type === 'dir') {
    expandedDirs.has(node.path) ? expandedDirs.delete(node.path) : expandedDirs.add(node.path);
    renderTree();
  } else { openFile(node.path); }
}

// ============================================================
// File search
// ============================================================
const fileSearchInput = document.getElementById('file-search');
let searchDebounce = null;
fileSearchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => { const q = fileSearchInput.value.trim(); q ? doFileSearch(q) : exitFileSearch(); }, 150);
});
fileSearchInput.addEventListener('keydown', e => { if (e.key === 'Escape') { fileSearchInput.value = ''; exitFileSearch(); } });

function doFileSearch(query) {
  const files = treeData.filter(i => i.type === 'file' && matchFilter(i.path, query, csFlags.file));
  const container = document.getElementById('search-results');
  document.getElementById('tree').classList.add('hidden');
  container.classList.remove('hidden'); container.innerHTML = '';
  if (!files.length) { container.innerHTML = '<div class="combo-empty" style="padding:.75rem">无匹配文件</div>'; return; }
  for (const f of files.slice(0, 100)) {
    const div = document.createElement('div'); div.className = 'search-result-item';
    const ic = document.createElement('span'); ic.className = 'icon'; ic.textContent = getFileIcon(f.path.split('/').pop()); div.appendChild(ic);
    const ps = document.createElement('span'); ps.className = 'sr-path';
    const parts = f.path.split('/'); const fn = parts.pop(); const dir = parts.join('/');
    const ne = document.createElement('span'); ne.className = 'sr-name'; ne.textContent = fn; ps.appendChild(ne);
    if (dir) { const de = document.createElement('span'); de.className = 'sr-dir'; de.textContent = ' — ' + dir; ps.appendChild(de); }
    div.appendChild(ps);
    div.addEventListener('click', () => {
      openFile(f.path);
      const segs = f.path.split('/'); let acc = '';
      for (let i = 0; i < segs.length - 1; i++) { acc = acc ? acc + '/' + segs[i] : segs[i]; expandedDirs.add(acc); }
    });
    container.appendChild(div);
  }
  if (files.length > 100) { const m = document.createElement('div'); m.className = 'combo-empty'; m.style.padding = '.5rem .75rem'; m.textContent = `还有 ${files.length - 100} 个结果未显示`; container.appendChild(m); }
}
function exitFileSearch() { document.getElementById('search-results').classList.add('hidden'); document.getElementById('tree').classList.remove('hidden'); renderTree(); }

// ============================================================
// File open / edit (local only, no API calls for save)
// ============================================================
async function openFile(path) {
  // Check if switching away from unsaved editor content
  if (currentFile) {
    const editorContent = document.getElementById('editor').value;
    const pending = pendingChanges.get(currentFile.path);
    const savedContent = pending ? pending.content : currentFile.originalContent;
    if (editorContent !== savedContent) {
      if (!confirm('编辑器中有未暂存的修改，确定切换？')) return;
    }
  }

  setStatus('正在加载 ' + path + '…');

  // If it's a pending new file, show from memory
  const pending = pendingChanges.get(path);
  if (pending && pending.type === 'A') {
    currentFile = { path, sha: null, originalContent: '' };
    document.getElementById('editor').value = pending.content || '';
    showEditor(path);
    setStatus('已打开 (新文件): ' + path);
    return;
  }

  try {
    const repo = fullRepo(); const c = readInputs();
    const data = await ghApi('GET', `/repos/${repo}/contents/${path}?ref=${c.branch}`);
    let content;
    if (data.encoding === 'base64') {
      try { content = decodeURIComponent(escape(atob(data.content.replace(/\n/g, '')))); }
      catch { content = atob(data.content.replace(/\n/g, '')); }
    } else { content = data.content || ''; }

    currentFile = { path, sha: data.sha, originalContent: content };
    // Show pending content if modified, otherwise original
    document.getElementById('editor').value = pending && pending.type === 'M' ? pending.content : content;
    showEditor(path);
    setStatus('已打开: ' + path);
  } catch (e) { setStatus('打开失败: ' + e.message); }
}

function showEditor(path) {
  document.getElementById('editor-wrap').classList.remove('hidden');
  document.getElementById('placeholder').classList.add('hidden');
  updateBreadcrumb(path);
  renderTree();
  if (window.innerWidth <= 768) switchMobileTab('editor');
}

// "暂存修改" button: save editor content to pendingChanges
async function stageCurrentFile() {
  if (!currentFile) return;
  const content = document.getElementById('editor').value;
  setStatus('正在比较 ' + currentFile.path + '…');
  await stageFile(currentFile.path, content);
  renderChanges();
  renderTree();
  setStatus('已暂存: ' + currentFile.path);
}

// "撤销修改" button: revert editor to original/pending content
function revertCurrentFile() {
  if (!currentFile) return;
  const pending = pendingChanges.get(currentFile.path);
  if (pending && pending.type === 'A') {
    // New file: revert to empty
    document.getElementById('editor').value = '';
  } else {
    document.getElementById('editor').value = currentFile.originalContent;
    pendingChanges.delete(currentFile.path);
  }
  renderChanges();
  renderTree();
  setStatus('已撤销: ' + currentFile.path);
}

function updateBreadcrumb(path) {
  const bc = document.getElementById('breadcrumb'); bc.innerHTML = '';
  const parts = path.split('/'); let acc = '';
  const root = document.createElement('a'); root.textContent = '🏠'; root.onclick = () => { currentFile = null; closeEditor(); }; bc.appendChild(root);
  parts.forEach((p, i) => {
    const sep = document.createElement('span'); sep.textContent = ' / '; bc.appendChild(sep);
    acc = acc ? acc + '/' + p : p;
    if (i < parts.length - 1) { const a = document.createElement('a'); a.textContent = p; const dp = acc; a.onclick = () => { expandedDirs.add(dp); renderTree(); }; bc.appendChild(a); }
    else { const s = document.createElement('span'); s.textContent = p; s.style.fontWeight = '600'; bc.appendChild(s); }
  });
}

function closeEditor() {
  document.getElementById('editor-wrap').classList.add('hidden');
  document.getElementById('placeholder').classList.remove('hidden');
  document.getElementById('breadcrumb').innerHTML = '';
  renderTree();
}

// ============================================================
// Changes panel
// ============================================================
function renderChanges() {
  const list = document.getElementById('changes-list');
  const countEl = document.getElementById('changes-count');
  const btn = document.getElementById('commit-push-btn');
  list.innerHTML = '';
  const n = pendingChanges.size;
  countEl.textContent = n > 0 ? `(${n})` : '';
  btn.disabled = n === 0;

  if (n === 0) {
    list.innerHTML = '<div class="combo-empty" style="padding:.75rem;text-align:center">没有待提交的变更</div>';
    return;
  }

  for (const [path, ch] of pendingChanges) {
    const div = document.createElement('div'); div.className = 'change-item';
    const badge = document.createElement('span'); badge.className = 'ch-type ' + ch.type;
    badge.textContent = ch.type === 'M' ? 'M' : ch.type === 'A' ? 'A' : ch.type === 'D' ? 'D' : 'R';
    badge.title = ch.type === 'M' ? '修改' : ch.type === 'A' ? '新增' : ch.type === 'D' ? '删除' : '重命名';
    div.appendChild(badge);

    const pathEl = document.createElement('span'); pathEl.className = 'ch-path';
    pathEl.textContent = ch.oldPath ? `${ch.oldPath} → ${path}` : path;
    pathEl.title = path;
    div.appendChild(pathEl);

    const undo = document.createElement('span'); undo.className = 'ch-undo'; undo.textContent = '✕'; undo.title = '撤销此变更';
    undo.onclick = () => { discardChange(path); };
    div.appendChild(undo);

    list.appendChild(div);
  }
}

function discardChange(path) {
  pendingChanges.delete(path);
  // If currently editing this file, revert editor
  if (currentFile && currentFile.path === path) {
    document.getElementById('editor').value = currentFile.originalContent || '';
  }
  renderChanges();
  renderTree();
  setStatus('已撤销变更: ' + path);
}

function discardAllChanges() {
  if (pendingChanges.size === 0) return;
  if (!confirm(`确定放弃所有 ${pendingChanges.size} 个变更？`)) return;
  pendingChanges.clear();
  if (currentFile) document.getElementById('editor').value = currentFile.originalContent || '';
  renderChanges();
  renderTree();
  setStatus('已放弃所有变更');
}

// ============================================================
// Commit & Push: apply all pending changes in one commit
// ============================================================
let isCommitting = false;
async function commitAndPush() {
  if (isCommitting || pendingChanges.size === 0) return;
  const msg = document.getElementById('commit-msg').value.trim();
  if (!msg) { setStatus('请输入 Commit message'); document.getElementById('commit-msg').focus(); return; }
  const desc = document.getElementById('commit-desc').value.trim();
  const fullMsg = desc ? msg + '\n\n' + desc : msg;

  const repo = fullRepo(); const c = readInputs();
  const btn = document.getElementById('commit-push-btn');
  btn.disabled = true; btn.textContent = '提交中…';
  isCommitting = true;
  setStatus('正在提交…');

  try {
    // 1. Get current branch ref
    const ref = await ghApi('GET', `/repos/${repo}/git/ref/heads/${c.branch}`);
    const headSha = ref.object.sha;
    const headCommit = await ghApi('GET', `/repos/${repo}/git/commits/${headSha}`);
    const baseTreeSha = headCommit.tree.sha;

    // 2. Get full current tree
    const fullTree = await ghApi('GET', `/repos/${repo}/git/trees/${baseTreeSha}?recursive=1`);
    const existingEntries = fullTree.tree.filter(i => i.type === 'blob' || i.type === 'tree');

    // 3. Build new tree entries
    // Start with all existing blobs (not trees, git rebuilds those)
    const deletedPaths = new Set();
    const modifiedPaths = new Map(); // path -> {content, binary}

    for (const [path, ch] of pendingChanges) {
      if (ch.type === 'D') {
        deletedPaths.add(path);
      } else if (ch.type === 'M' || ch.type === 'A') {
        modifiedPaths.set(path, { content: ch.content, binary: !!ch.binary });
      } else if (ch.type === 'R') {
        deletedPaths.add(ch.oldPath);
        modifiedPaths.set(path, { content: ch.content, binary: !!ch.binary });
      }
    }

    // Filter existing blobs, removing deleted ones
    const newTreeEntries = existingEntries
      .filter(i => i.type === 'blob' && !deletedPaths.has(i.path) && !modifiedPaths.has(i.path))
      .map(i => ({ path: i.path, mode: i.mode, type: 'blob', sha: i.sha }));

    // Add modified/new files
    for (const [path, info] of modifiedPaths) {
      // Create blob: binary files are already base64, text files need encoding
      const blob = await ghApi('POST', `/repos/${repo}/git/blobs`, {
        content: info.binary ? info.content : btoa(unescape(encodeURIComponent(info.content))),
        encoding: 'base64',
      });
      newTreeEntries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    // 4. Create new tree
    const newTree = await ghApi('POST', `/repos/${repo}/git/trees`, { tree: newTreeEntries });

    // 5. Create commit
    const newCommit = await ghApi('POST', `/repos/${repo}/git/commits`, {
      message: fullMsg,
      tree: newTree.sha,
      parents: [headSha],
    });

    // 6. Update ref (push)
    await ghApi('PATCH', `/repos/${repo}/git/refs/heads/${c.branch}`, { sha: newCommit.sha });

    // Success: clear changes and reload
    pendingChanges.clear();
    document.getElementById('commit-msg').value = '';
    document.getElementById('commit-desc').value = '';
    setStatus('已提交并推送: ' + msg);
    await loadTree();
  } catch (e) {
    setStatus('提交失败: ' + e.message);
  } finally {
    isCommitting = false;
    btn.disabled = pendingChanges.size === 0;
    btn.textContent = '🚀 Commit & Push';
  }
}

// ============================================================
// Context menu & CRUD (all operations are local/pending)
// ============================================================
function showContextMenu(e, node) {
  const menu = document.getElementById('ctx-menu'); menu.innerHTML = '';
  menu.classList.remove('hidden'); menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px';
  const items = [];
  if (node.type === 'dir') {
    items.push({ label: '📄 新建文件', action: () => promptNewFile(node.path) });
    items.push({ label: '📁 新建文件夹', action: () => promptNewFolder(node.path) });
    items.push({ label: '📤 上传文件', action: () => triggerUpload(node.path) });
    items.push({ label: '⬇️ 下载文件夹', action: () => downloadFolder(node.path) });
    items.push({ sep: true });
    items.push({ label: '✏️ 重命名', action: () => promptRename(node) });
    items.push({ label: '📋 复制到…', action: () => promptCopy(node) });
    items.push({ label: '📦 移动到…', action: () => promptMove(node) });
    items.push({ sep: true });
    items.push({ label: '🗑️ 删除', action: () => stageDeleteNode(node), danger: true });
  } else {
    items.push({ label: '📖 打开', action: () => openFile(node.path) });
    items.push({ label: '⬇️ 下载', action: () => downloadFile(node.path) });
    items.push({ sep: true });
    items.push({ label: '✏️ 重命名', action: () => promptRename(node) });
    items.push({ label: '📋 复制到…', action: () => promptCopy(node) });
    items.push({ label: '📦 移动到…', action: () => promptMove(node) });
    items.push({ sep: true });
    items.push({ label: '🗑️ 删除', action: () => stageDeleteNode(node), danger: true });
  }
  for (const item of items) {
    if (item.sep) { const d = document.createElement('div'); d.className = 'ctx-menu-sep'; menu.appendChild(d); }
    else { const d = document.createElement('div'); d.className = 'ctx-menu-item' + (item.danger ? ' danger' : ''); d.textContent = item.label; d.onclick = () => { hideContextMenu(); item.action(); }; menu.appendChild(d); }
  }
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = (window.innerWidth - r.width - 8) + 'px';
    if (r.bottom > window.innerHeight) menu.style.top = (window.innerHeight - r.height - 8) + 'px';
  });
}
function hideContextMenu() { document.getElementById('ctx-menu').classList.add('hidden'); }
document.addEventListener('click', hideContextMenu);

// ---- Modal ----
function showModal(title, fields, onConfirm) {
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
  const modal = document.createElement('div'); modal.className = 'modal';
  const h3 = document.createElement('h3'); h3.textContent = title; modal.appendChild(h3);
  const inputs = {};
  for (const f of fields) {
    const label = document.createElement('label'); label.textContent = f.label; modal.appendChild(label);
    const input = document.createElement('input'); input.type = 'text'; input.value = f.value || ''; input.placeholder = f.placeholder || '';
    inputs[f.key] = input; modal.appendChild(input);
  }
  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const cancelBtn = document.createElement('button'); cancelBtn.className = 'btn btn-ghost'; cancelBtn.textContent = '取消'; cancelBtn.onclick = () => overlay.remove();
  const confirmBtn = document.createElement('button'); confirmBtn.className = 'btn btn-primary'; confirmBtn.textContent = '确认';
  confirmBtn.onclick = async () => {
    const values = {}; for (const k in inputs) values[k] = inputs[k].value.trim();
    try { await onConfirm(values); overlay.remove(); }
    catch (e) { setStatus('操作失败: ' + e.message); }
  };
  actions.appendChild(cancelBtn); actions.appendChild(confirmBtn); modal.appendChild(actions);
  overlay.appendChild(modal);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('modal-container').appendChild(overlay);
  const first = Object.values(inputs)[0]; if (first) setTimeout(() => first.focus(), 50);
}

// ---- New file (local) ----
function promptNewFile(dirPath) {
  const prefix = dirPath ? dirPath + '/' : '';
  showModal('新建文件', [{ key: 'name', label: '文件名', placeholder: 'example.txt' }], async (v) => {
    if (!v.name) throw new Error('请输入文件名');
    const nameErr = validateName(v.name);
    if (nameErr) throw new Error(nameErr);
    const path = prefix + v.name;
    await stageFile(path, '');
    renderChanges(); renderTree();
    setStatus('已添加新文件: ' + path);
    openFile(path);
  });
}

// ---- New folder (via .gitkeep) ----
function promptNewFolder(dirPath) {
  const prefix = dirPath ? dirPath + '/' : '';
  showModal('新建文件夹', [{ key: 'name', label: '文件夹名', placeholder: 'new-folder' }], async (v) => {
    if (!v.name) throw new Error('请输入文件夹名');
    const nameErr = validateName(v.name);
    if (nameErr) throw new Error(nameErr);
    const path = prefix + v.name + '/.gitkeep';
    await stageFile(path, '');
    renderChanges(); renderTree();
    setStatus('已添加新文件夹: ' + prefix + v.name);
  });
}

// ---- Delete (stage) ----
function stageDeleteNode(node) {
  if (node.type === 'file') {
    stageDelete(node.path);
    if (currentFile && currentFile.path === node.path) closeEditor();
  } else {
    // Delete all files under this dir
    const files = treeData.filter(i => i.type === 'file' && i.path.startsWith(node.path + '/'));
    for (const f of files) stageDelete(f.path);
    // Also delete any pending new files under this dir
    const toRemove = [...pendingChanges.keys()].filter(p => pendingChanges.get(p).type === 'A' && p.startsWith(node.path + '/'));
    for (const p of toRemove) pendingChanges.delete(p);
    if (currentFile && currentFile.path.startsWith(node.path + '/')) closeEditor();
  }
  renderChanges(); renderTree();
  setStatus('已标记删除: ' + node.path);
}

// ---- Rename (local) ----
function promptRename(node) {
  const oldName = node.path.split('/').pop();
  const parentPath = node.path.split('/').slice(0, -1).join('/');
  showModal('重命名', [{ key: 'name', label: '新名称', value: oldName }], async (v) => {
    if (!v.name || v.name === oldName) throw new Error('请输入新名称');
    const nameErr = validateName(v.name);
    if (nameErr) throw new Error(nameErr);
    const newPath = parentPath ? parentPath + '/' + v.name : v.name;
    if (node.type === 'file') {
      await stageRenameFile(node.path, newPath);
    } else {
      await stageRenameDir(node.path, newPath);
    }
    renderChanges(); renderTree();
    setStatus('已标记重命名: ' + node.path + ' → ' + newPath);
  });
}

// ---- Move (local) ----
function promptMove(node) {
  showModal('移动到', [{ key: 'dest', label: '目标文件夹', value: '', placeholder: 'path/to/folder' }], async (v) => {
    const name = node.path.split('/').pop();
    const newPath = v.dest ? v.dest.replace(/\/+$/, '') + '/' + name : name;
    if (newPath === node.path) throw new Error('目标路径与原路径相同');
    const pathErr = validatePath(newPath);
    if (pathErr) throw new Error(pathErr);
    if (node.type === 'file') { await stageRenameFile(node.path, newPath); }
    else { await stageRenameDir(node.path, newPath); }
    renderChanges(); renderTree();
    setStatus('已标记移动: ' + node.path + ' → ' + newPath);
  });
}

// ---- Copy (local) ----
function promptCopy(node) {
  showModal('复制到', [{ key: 'dest', label: '目标路径', value: node.path + '-copy' }], async (v) => {
    if (!v.dest || v.dest === node.path) throw new Error('请输入不同的目标路径');
    const pathErr = validatePath(v.dest);
    if (pathErr) throw new Error(pathErr);
    if (node.type === 'file') { await stageCopyFile(node.path, v.dest); }
    else { await stageCopyDir(node.path, v.dest); }
    renderChanges(); renderTree();
    setStatus('已标记复制: ' + node.path + ' → ' + v.dest);
  });
}

// ============================================================
// Rename/Move/Copy helpers (fetch content, stage locally)
// ============================================================
async function getFileContent(path) {
  // If pending A or M, use that content directly
  const pending = pendingChanges.get(path);
  if (pending && (pending.type === 'A' || pending.type === 'M')) {
    return { content: pending.content, binary: !!pending.binary };
  }
  // Otherwise fetch from remote (works for D or no pending)
  const data = await getFileBlob(path);
  if (data instanceof Uint8Array) {
    // 重新编码为 base64 字符串
    let binary = '';
    for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
    const base64 = btoa(binary);
    return { content: base64, binary: true };
  }
  return { content: data, binary: false };
}

async function stageRenameFile(oldPath, newPath) {
  const { content, binary } = await getFileContent(oldPath);
  if (pendingChanges.has(oldPath) && pendingChanges.get(oldPath).type === 'A') {
    pendingChanges.delete(oldPath);
  } else {
    stageDelete(oldPath);
  }
  await stageFile(newPath, content, { binary });
  if (currentFile && currentFile.path === oldPath) closeEditor();
}

async function stageRenameDir(oldDir, newDir) {
  const files = treeData.filter(i => i.type === 'file' && i.path.startsWith(oldDir + '/'));
  const pendingNew = [...pendingChanges.entries()].filter(([p, ch]) => ch.type === 'A' && p.startsWith(oldDir + '/'));
  for (const f of files) {
    const newPath = newDir + f.path.substring(oldDir.length);
    await stageRenameFile(f.path, newPath);
  }
  const processedPaths = new Set(files.map(f => f.path));
  for (const [p, ch] of pendingNew) {
    if (!processedPaths.has(p)) {
      const newPath = newDir + p.substring(oldDir.length);
      pendingChanges.delete(p);
      await stageFile(newPath, ch.content);
    }
  }
  if (currentFile && currentFile.path.startsWith(oldDir + '/')) closeEditor();
}

async function stageCopyFile(srcPath, destPath) {
  const { content, binary } = await getFileContent(srcPath);
  await stageFile(destPath, content, { binary });
}

async function stageCopyDir(srcDir, destDir) {
  const files = treeData.filter(i => i.type === 'file' && i.path.startsWith(srcDir + '/'));
  for (const f of files) {
    const newPath = destDir + f.path.substring(srcDir.length);
    await stageCopyFile(f.path, newPath);
  }
  for (const [p, ch] of pendingChanges) {
    if (ch.type === 'A' && p.startsWith(srcDir + '/')) {
      const newPath = destDir + p.substring(srcDir.length);
      await stageFile(newPath, ch.content);
    }
  }
}

// ============================================================
// File upload
// ============================================================
let uploadTargetDir = ''; // set when uploading into a specific folder

const TEXT_EXT_RE = /\.(txt|md|json|js|ts|py|html|css|xml|yml|yaml|sh|csv|svg|ini|cfg|toml|env|gitignore|gitkeep)$/i;
function isTextFile(file) {
  return file.type.startsWith('text/') || TEXT_EXT_RE.test(file.name);
}

function triggerUpload(dirPath) {
  uploadTargetDir = dirPath || '';
  const input = document.getElementById('file-upload');
  input.value = '';
  input.click();
}

function handleUpload(input) {
  const files = input.files;
  if (!files || !files.length) return;
  const prefix = uploadTargetDir ? uploadTargetDir + '/' : '';
  let count = 0;
  let added = 0, modified = 0, skipped = 0;

  for (const file of files) {
    const path = prefix + file.name;
    const reader = new FileReader();
    const text = isTextFile(file);
    reader.onload = async () => {
      const content = text ? reader.result : (reader.result.split(',')[1] || '');
      const result = await stageFile(path, content, { binary: !text });
      if (result === 'A') added++;
      else if (result === 'M') modified++;
      else skipped++;

      count++;
      if (count === files.length) {
        renderChanges(); renderTree();
        const parts = [];
        if (added) parts.push(`${added} 个新增`);
        if (modified) parts.push(`${modified} 个修改`);
        if (skipped) parts.push(`${skipped} 个无变化已跳过`);
        setStatus(`已处理: ${parts.join(', ') || '无变更'}`);
      }
    };
    text ? reader.readAsText(file) : reader.readAsDataURL(file);
  }
}

// ============================================================
// File download
// ============================================================
async function getFileBlob(path) {
  const pending = pendingChanges.get(path);
  let content, isBinary = false;

  if (pending && (pending.type === 'A' || pending.type === 'M')) {
    content = pending.content;
    isBinary = !!pending.binary;
  } else {
    const repo = fullRepo(); const c = readInputs();
    const data = await ghApi('GET', `/repos/${repo}/contents/${path}?ref=${c.branch}`);
    if (data.encoding === 'base64') {
      content = data.content.replace(/\n/g, '');
      isBinary = true;
    } else {
      content = data.content || '';
    }
  }

  if (isBinary) {
    const bytes = atob(content);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return arr;
  }
  return content;
}

function triggerBrowserDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function downloadFile(path) {
  setStatus('正在下载 ' + path + '…');
  try {
    const data = await getFileBlob(path);
    const fileName = path.split('/').pop();
    const blob = data instanceof Uint8Array
      ? new Blob([data])
      : new Blob([data], { type: 'text/plain;charset=utf-8' });
    triggerBrowserDownload(blob, fileName);
    setStatus('已下载: ' + fileName);
  } catch (e) { setStatus('下载失败: ' + e.message); }
}

function downloadCurrentFile() {
  if (currentFile) downloadFile(currentFile.path);
}

async function downloadFolder(dirPath) {
  const files = treeData.filter(i => i.type === 'file' && i.path.startsWith(dirPath + '/'))
    .filter(f => !(pendingChanges.has(f.path) && pendingChanges.get(f.path).type === 'D'));
  // Also include pending new files under this dir
  const existingPaths = new Set(files.map(f => f.path));
  for (const [p, ch] of pendingChanges) {
    if (ch.type === 'A' && p.startsWith(dirPath + '/') && !existingPaths.has(p)) {
      files.push({ path: p, type: 'file' });
    }
  }
  if (!files.length) { setStatus('文件夹为空'); return; }

  const folderName = dirPath.split('/').pop();
  setStatus(`正在打包 ${folderName}/ (${files.length} 个文件)…`);

  try {
    const zip = new JSZip();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setStatus(`正在打包 (${i + 1}/${files.length}): ${f.path}`);
      const data = await getFileBlob(f.path);
      // Use folder name as root directory inside zip to preserve the original name
      const relativePath = folderName + '/' + f.path.substring(dirPath.length + 1);
      zip.file(relativePath, data);
    }
    setStatus('正在生成 ZIP…');
    const blob = await zip.generateAsync({ type: 'blob' });
    triggerBrowserDownload(blob, folderName + '.zip');
    setStatus(`已下载: ${folderName}.zip (${files.length} 个文件)`);
  } catch (e) { setStatus('下载失败: ' + e.message); }
}

// ---- Keyboard shortcut ----
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (currentFile) stageCurrentFile();
  }
});

// ============================================================
// Mobile tab switching
// ============================================================
function toggleTopbar() {
  document.getElementById('topbar-fields').classList.toggle('open');
}

function switchMobileTab(tab) {
  const panels = {
    files: document.getElementById('files-panel'),
    editor: document.querySelector('.main-area > .content'),
    changes: document.getElementById('changes-panel'),
  };
  // Remove mobile-visible from all panels
  Object.values(panels).forEach(p => p.classList.remove('mobile-visible'));
  // Add to selected
  if (panels[tab]) panels[tab].classList.add('mobile-visible');
  // Update tab buttons
  const btns = document.querySelectorAll('#mobile-tabs button');
  btns.forEach(b => b.classList.remove('active'));
  const idx = { files: 0, editor: 1, changes: 2 };
  if (btns[idx[tab]]) btns[idx[tab]].classList.add('active');
}

// Initialize mobile: show files tab by default
if (window.innerWidth <= 768) switchMobileTab('files');
