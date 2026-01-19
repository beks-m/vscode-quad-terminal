const vscode = acquireVsCodeApi();

// Tab state management
const tabState = {
  1: {
    terminals: [],
    fitAddons: [],
    terminalInitialized: [false, false, false, false],
    terminalProjects: ['', '', '', ''],
    visibleTerminalCount: 1
  }
};
let activeTabId = 1;
let nextTabId = 2;

// Helper to get current tab state
function getActiveTab() {
  return tabState[activeTabId];
}

function getTab(tabId) {
  return tabState[tabId];
}

// Get VS Code terminal colors from CSS variables
function getVSCodeColor(varName, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || fallback;
}

const theme = {
  background: getVSCodeColor('--vscode-terminal-background', '') || getVSCodeColor('--vscode-editor-background', '#1e1e1e'),
  foreground: getVSCodeColor('--vscode-terminal-foreground', '') || getVSCodeColor('--vscode-editor-foreground', '#cccccc'),
  cursor: getVSCodeColor('--vscode-terminalCursor-foreground', '#ffffff'),
  cursorAccent: getVSCodeColor('--vscode-terminalCursor-background', '#000000'),
  selectionBackground: getVSCodeColor('--vscode-terminal-selectionBackground', '#264f78'),
  selectionForeground: getVSCodeColor('--vscode-terminal-selectionForeground', ''),
  black: getVSCodeColor('--vscode-terminal-ansiBlack', '#000000'),
  red: getVSCodeColor('--vscode-terminal-ansiRed', '#cd3131'),
  green: getVSCodeColor('--vscode-terminal-ansiGreen', '#0dbc79'),
  yellow: getVSCodeColor('--vscode-terminal-ansiYellow', '#e5e510'),
  blue: getVSCodeColor('--vscode-terminal-ansiBlue', '#2472c8'),
  magenta: getVSCodeColor('--vscode-terminal-ansiMagenta', '#bc3fbc'),
  cyan: getVSCodeColor('--vscode-terminal-ansiCyan', '#11a8cd'),
  white: getVSCodeColor('--vscode-terminal-ansiWhite', '#e5e5e5'),
  brightBlack: getVSCodeColor('--vscode-terminal-ansiBrightBlack', '#666666'),
  brightRed: getVSCodeColor('--vscode-terminal-ansiBrightRed', '#f14c4c'),
  brightGreen: getVSCodeColor('--vscode-terminal-ansiBrightGreen', '#23d18b'),
  brightYellow: getVSCodeColor('--vscode-terminal-ansiBrightYellow', '#f5f543'),
  brightBlue: getVSCodeColor('--vscode-terminal-ansiBrightBlue', '#3b8eea'),
  brightMagenta: getVSCodeColor('--vscode-terminal-ansiBrightMagenta', '#d670d6'),
  brightCyan: getVSCodeColor('--vscode-terminal-ansiBrightCyan', '#29b8db'),
  brightWhite: getVSCodeColor('--vscode-terminal-ansiBrightWhite', '#ffffff')
};

// Get VS Code terminal font settings
const terminalFontFamily = getVSCodeColor('--vscode-terminal-font-family', '') ||
                           getVSCodeColor('--vscode-editor-font-family', 'Menlo, Monaco, "Courier New", monospace');
const terminalFontSize = parseInt(getVSCodeColor('--vscode-terminal-font-size', '12')) || 12;

// Setup event listeners for initial tab (Tab 1) terminals
function setupTerminalEventListeners(tabId, terminalId) {
  const killBtn = document.getElementById('kill-' + tabId + '-' + terminalId);
  if (killBtn) {
    killBtn.addEventListener('click', function() {
      vscode.postMessage({
        command: 'kill',
        tabId: tabId,
        terminalId: terminalId
      });
    });
  }

  const fullscreenBtn = document.getElementById('fullscreen-' + tabId + '-' + terminalId);
  if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', function() {
      toggleFullscreen(terminalId);
    });
  }

  const pickFilesBtn = document.getElementById('pick-files-' + tabId + '-' + terminalId);
  if (pickFilesBtn) {
    pickFilesBtn.addEventListener('click', function() {
      vscode.postMessage({
        command: 'pickFiles',
        tabId: tabId,
        terminalId: terminalId
      });
    });
  }

  const restartBtn = document.getElementById('restart-' + tabId + '-' + terminalId);
  if (restartBtn) {
    restartBtn.addEventListener('click', function() {
      vscode.postMessage({
        command: 'restart',
        tabId: tabId,
        terminalId: terminalId
      });
    });
  }

  // Drag and drop support for files
  const termContainer = document.getElementById('term-container-' + tabId + '-' + terminalId);
  if (!termContainer) return;

  termContainer.addEventListener('dragenter', function(e) {
    e.preventDefault();
    e.stopPropagation();
    termContainer.classList.add('drag-over');
  });

  termContainer.addEventListener('dragleave', function(e) {
    // Only remove if leaving the container entirely
    if (!termContainer.contains(e.relatedTarget)) {
      termContainer.classList.remove('drag-over');
    }
  });

  termContainer.addEventListener('dragover', function(e) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  });

  termContainer.addEventListener('drop', function(e) {
    e.preventDefault();
    e.stopPropagation();
    termContainer.classList.remove('drag-over');

    var tab = getTab(tabId);
    if (!tab || !tab.terminalInitialized[terminalId]) return;

    var paths = [];

    // Helper to extract path from URI
    function extractPath(uri) {
      if (!uri) return null;
      uri = uri.trim();
      if (!uri || uri.startsWith('#')) return null;

      if (uri.startsWith('file://')) {
        var path = decodeURIComponent(uri.slice(7));
        // Windows: file:///C:/path -> C:/path
        if (path.length > 2 && path[0] === '/' && path[2] === ':') {
          path = path.slice(1);
        }
        return path;
      } else if (uri.startsWith('/') || /^[A-Za-z]:[\\\\//]/.test(uri)) {
        return uri;
      }
      return null;
    }

    // Collect all available data types
    var types = Array.from(e.dataTransfer.types || []);

    // Try various data formats
    var uriList = e.dataTransfer.getData('text/uri-list');
    var text = e.dataTransfer.getData('text/plain');
    var resourceUrls = e.dataTransfer.getData('resourceurls');
    var codeFiles = e.dataTransfer.getData('codefiles');

    // DEBUG: Show what we received
    console.log('=== DROP DEBUG ===');
    console.log('types:', types);
    console.log('uriList:', uriList);
    console.log('text:', text);
    console.log('resourceUrls:', resourceUrls);
    console.log('codeFiles:', codeFiles);
    console.log('files:', e.dataTransfer.files.length);
    for (var fi = 0; fi < e.dataTransfer.files.length; fi++) {
      var f = e.dataTransfer.files[fi];
      console.log('file', fi, ':', f.name, f.path, f.type);
    }
    // Try all types
    types.forEach(function(t) {
      console.log('getData(' + t + '):', e.dataTransfer.getData(t));
    });
    console.log('==================');

    // Try VS Code resource URLs first
    if (resourceUrls) {
      try {
        var resources = JSON.parse(resourceUrls);
        resources.forEach(function(r) {
          var path = extractPath(r);
          if (path) paths.push(path);
        });
      } catch (err) {}
    }

    // Try codefiles
    if (paths.length === 0 && codeFiles) {
      try {
        var files = JSON.parse(codeFiles);
        files.forEach(function(f) {
          var path = extractPath(f);
          if (path) paths.push(path);
        });
      } catch (err) {}
    }

    // Try URI list
    if (paths.length === 0 && uriList) {
      uriList.split(/\r?\n/).forEach(function(uri) {
        var path = extractPath(uri);
        if (path) paths.push(path);
      });
    }

    // Try plain text (might contain paths)
    if (paths.length === 0 && text) {
      text.split(/\r?\n/).forEach(function(line) {
        var path = extractPath(line);
        if (path) paths.push(path);
      });
    }

    // Try Files API
    if (paths.length === 0 && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      for (var fi2 = 0; fi2 < e.dataTransfer.files.length; fi2++) {
        var file = e.dataTransfer.files[fi2];
        if (file.path) paths.push(file.path);
        else if (file.name) paths.push(file.name);
      }
    }

    if (paths.length > 0) {
      var quotedPaths = paths.map(function(p) { return p.includes(' ') ? '"' + p + '"' : p; });
      vscode.postMessage({
        command: 'input',
        tabId: tabId,
        terminalId: terminalId,
        data: quotedPaths.join(' ')
      });
      if (tab.terminals[terminalId]) tab.terminals[terminalId].focus();
    } else {
      // Send all data to extension for resolution
      vscode.postMessage({
        command: 'resolveDrop',
        tabId: tabId,
        terminalId: terminalId,
        data: { uriList: uriList, text: text, resourceUrls: resourceUrls, codeFiles: codeFiles, types: types }
      });
      if (tab.terminals[terminalId]) tab.terminals[terminalId].focus();
    }
  });
}

// Setup initial tab terminals
for (var i = 0; i < 4; i++) {
  setupTerminalEventListeners(1, i);
}

let currentFullscreen = -1;
// visibleTerminalCount is now per-tab in tabState

function updateTerminalCount() {
  const tab = getActiveTab();
  document.getElementById('terminal-count').textContent = (tab ? tab.visibleTerminalCount : 1) + ' / 4';
}

function createTab(tabId) {
  tabState[tabId] = {
    terminals: [],
    fitAddons: [],
    terminalInitialized: [false, false, false, false],
    terminalProjects: ['', '', '', ''],
    visibleTerminalCount: 1
  };

  // Create tab button
  var tabBar = document.getElementById('tab-bar');
  var addTabBtn = document.getElementById('add-tab-btn');

  var tabBtn = document.createElement('button');
  tabBtn.className = 'tab-button';
  tabBtn.dataset.tabId = tabId;
  tabBtn.innerHTML = '<span class="tab-label">Tab ' + tabId + '</span><span class="tab-activity"></span><span class="tab-close" title="Close tab"><svg viewBox="0 0 16 16"><path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z"/></svg></span>';
  tabBar.insertBefore(tabBtn, addTabBtn);

  // Create grid for this tab
  var gridContainer = document.querySelector('.grid-container');
  var newGrid = createGridForTab(tabId);
  gridContainer.appendChild(newGrid);

  // Setup terminal event listeners for new tab
  for (var i = 0; i < 4; i++) {
    setupTerminalEventListeners(tabId, i);
  }

  // Attach event listeners
  attachTabButtonListeners(tabBtn);

  // Switch to new tab (UI only, extension already knows)
  switchTabUI(tabId);
}

function createGridForTab(tabId) {
  const grid = document.createElement('div');
  grid.className = 'grid terminals-1';
  grid.dataset.tabId = tabId;
  grid.style.display = 'none';

  for (let i = 0; i < 4; i++) {
    const container = document.createElement('div');
    container.className = i === 0 ? 'terminal-container' : 'terminal-container hidden-slot';
    container.id = 'term-container-' + tabId + '-' + i;
    container.innerHTML = '<div class="terminal-header"><span class="terminal-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span><span class="terminal-title empty" id="terminal-title-' + tabId + '-' + i + '">Terminal ' + (i + 1) + '</span><div class="header-actions"><button class="action-btn pick-files-btn" id="pick-files-' + tabId + '-' + i + '" title="Insert file path"><svg viewBox="0 0 16 16"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.76.56 2.311 1.184C7.985 3.648 8.48 4 9 4h4.5A1.5 1.5 0 0 1 15 5.5v.64c.57.265.94.876.856 1.546l-.64 5.124A2.5 2.5 0 0 1 12.733 15H3.266a2.5 2.5 0 0 1-2.481-2.19l-.64-5.124A1.5 1.5 0 0 1 1 6.14V3.5zM2 6h12v-.5a.5.5 0 0 0-.5-.5H9c-.964 0-1.71-.629-2.174-1.154C6.374 3.334 5.82 3 5.264 3H2.5a.5.5 0 0 0-.5.5V6z"/></svg></button><button class="action-btn fullscreen-btn" id="fullscreen-' + tabId + '-' + i + '" title="Toggle fullscreen"><svg class="expand-icon" viewBox="0 0 16 16"><path d="M3 3v4h1V4h3V3H3zm10 0h-4v1h3v3h1V3zM4 12v-3H3v4h4v-1H4zm8-3v3h-3v1h4V9h-1z"/></svg><svg class="collapse-icon" style="display:none" viewBox="0 0 16 16"><path d="M2 2h5v5H2V2zm1 1v3h3V3H3zm7-1h5v5h-5V2zm1 1v3h3V3h-3zM2 9h5v5H2V9zm1 1v3h3v-3H3zm7-1h5v5h-5V9zm1 1v3h3v-3h-3z"/></svg></button><button class="action-btn restart-btn" id="restart-' + tabId + '-' + i + '" title="Restart terminal"><svg viewBox="0 0 16 16"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 1 1 .908-.418A6 6 0 1 1 8 2v1z"/><path d="M8 1v3.5a.5.5 0 0 0 .854.354l1.5-1.5a.5.5 0 0 0-.708-.708L8.5 3.793V1a.5.5 0 0 0-1 0z"/></svg></button><button class="action-btn kill-btn" id="kill-' + tabId + '-' + i + '" title="Kill terminal"><svg viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4L4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg></button></div><span class="status-indicator" id="status-' + tabId + '-' + i + '"></span></div><div class="terminal-wrapper"><div id="terminal-' + tabId + '-' + i + '"><div class="terminal-placeholder"><span class="terminal-placeholder-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span><span class="terminal-placeholder-text">Select a project and click "Add Terminal"</span></div></div></div>';
    grid.appendChild(container);
  }

  return grid;
}

function switchTabUI(tabId) {
  if (!tabState[tabId]) return;

  activeTabId = tabId;

  // Update tab buttons
  document.querySelectorAll('.tab-button').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.tabId) === tabId);
  });

  // Show/hide grids
  document.querySelectorAll('.grid').forEach(grid => {
    grid.style.display = parseInt(grid.dataset.tabId) === tabId ? '' : 'none';
  });

  // Clear activity indicator
  const activeBtn = document.querySelector('.tab-button[data-tab-id="' + tabId + '"]');
  if (activeBtn) activeBtn.classList.remove('has-activity');

  // Update terminal count for this tab
  updateTerminalCount();

  // Refit terminals
  setTimeout(fitAll, 50);
}

function switchTab(tabId) {
  switchTabUI(tabId);
  vscode.postMessage({ command: 'switchTab', tabId: tabId });
}

function closeTab(tabId) {
  vscode.postMessage({ command: 'closeTab', tabId: tabId });
}

function removeTab(tabId) {
  // Remove tab button
  const tabBtn = document.querySelector('.tab-button[data-tab-id="' + tabId + '"]');
  if (tabBtn) tabBtn.remove();

  // Remove grid
  const grid = document.querySelector('.grid[data-tab-id="' + tabId + '"]');
  if (grid) grid.remove();

  // Clean up state
  delete tabState[tabId];
}

function attachTabButtonListeners(tabBtn) {
  const tabId = parseInt(tabBtn.dataset.tabId);

  tabBtn.addEventListener('click', function(e) {
    if (!e.target.closest('.tab-close')) {
      switchTab(tabId);
    }
  });

  const closeBtn = tabBtn.querySelector('.tab-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      closeTab(tabId);
    });
  }
}

function updateGridLayout() {
  const tab = getActiveTab();
  const visibleTerminalCount = tab ? tab.visibleTerminalCount : 1;
  const grid = document.querySelector('.grid[data-tab-id="' + activeTabId + '"]');
  if (!grid) return;
  grid.classList.remove('terminals-1', 'terminals-2');
  if (visibleTerminalCount === 1) {
    grid.classList.add('terminals-1');
  } else if (visibleTerminalCount === 2) {
    grid.classList.add('terminals-2');
  }
  // For 3-4 terminals, use default 2x2 grid (no extra class needed)

  // Update add button state
  updateAddButtonState();

  // Update terminal count display
  updateTerminalCount();

  // Refit terminals after layout change
  setTimeout(fitAll, 50);
}

function removeTerminalSlot(terminalId) {
  var tab = getActiveTab();
  if (!tab) return;

  var container = document.getElementById('term-container-' + activeTabId + '-' + terminalId);
  if (container) container.classList.add('hidden-slot');

  // Recalculate visible terminal count
  tab.visibleTerminalCount = 0;
  for (var i = 0; i < 4; i++) {
    var c = document.getElementById('term-container-' + activeTabId + '-' + i);
    if (c && !c.classList.contains('hidden-slot')) {
      tab.visibleTerminalCount++;
    }
  }

  // Ensure at least one terminal slot is visible (show placeholder)
  if (tab.visibleTerminalCount === 0) {
    var firstContainer = document.getElementById('term-container-' + activeTabId + '-0');
    if (firstContainer) {
      firstContainer.classList.remove('hidden-slot');
      tab.visibleTerminalCount = 1;
      // Restore placeholder content
      var termEl = document.getElementById('terminal-' + activeTabId + '-0');
      if (termEl && !termEl.querySelector('.terminal-placeholder')) {
        termEl.innerHTML = '<div class="terminal-placeholder"><span class="terminal-placeholder-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span><span class="terminal-placeholder-text">Select a project and click "Add Terminal"</span></div>';
        tab.terminalInitialized[0] = false;
      }
    }
  }

  updateGridLayout();
}

function hasAvailableSlot() {
  var tab = getActiveTab();
  if (!tab) return false;
  // Check for visible empty slot (no active project)
  for (var i = 0; i < 4; i++) {
    var container = document.getElementById('term-container-' + activeTabId + '-' + i);
    if (container && !container.classList.contains('hidden-slot') && !tab.terminalProjects[i]) {
      return true;
    }
  }
  // Check for hidden slot
  for (var i = 0; i < 4; i++) {
    var container = document.getElementById('term-container-' + activeTabId + '-' + i);
    if (container && container.classList.contains('hidden-slot')) {
      return true;
    }
  }
  return false;
}

function startTerminalWithProject(terminalId, projectPath, projectName, resume) {
  var tab = getActiveTab();
  if (!tab) return;

  // Initialize the terminal UI
  initializeTerminal(terminalId);

  // Update terminal title
  var titleEl = document.getElementById('terminal-title-' + activeTabId + '-' + terminalId);
  if (titleEl) {
    titleEl.textContent = projectName;
    titleEl.classList.remove('empty');
  }

  // Store project info
  tab.terminalProjects[terminalId] = projectPath;

  // Update status indicator
  var statusEl = document.getElementById('status-' + activeTabId + '-' + terminalId);
  if (statusEl) statusEl.classList.add('active');

  // Send message to extension to start the terminal
  vscode.postMessage({
    command: 'selectProject',
    tabId: activeTabId,
    terminalId: terminalId,
    projectPath: projectPath,
    resume: resume
  });
}

function updateAddButtonState() {
  const globalSelect = document.getElementById('global-project-select');
  const addBtn = document.getElementById('add-terminal-btn');
  const hasProject = globalSelect.value !== '';
  addBtn.disabled = !hasProject || !hasAvailableSlot();
}

// Update button state when project selection changes
document.getElementById('global-project-select').addEventListener('change', updateAddButtonState);

function addTerminal() {
  var tab = getActiveTab();
  if (!tab) return;

  var globalSelect = document.getElementById('global-project-select');
  var projectPath = globalSelect.value;
  var projectName = globalSelect.options[globalSelect.selectedIndex] ? globalSelect.options[globalSelect.selectedIndex].text : '';
  var resume = document.getElementById('global-resume').checked;

  // Require a project to be selected
  if (!projectPath) {
    return;
  }

  // Find an available slot
  var targetTerminalId = -1;

  // First, check for a visible empty slot (no active project)
  for (var i = 0; i < 4; i++) {
    var container = document.getElementById('term-container-' + activeTabId + '-' + i);
    if (container && !container.classList.contains('hidden-slot') && !tab.terminalProjects[i]) {
      targetTerminalId = i;
      break;
    }
  }

  // If no visible empty slot, find a hidden slot and show it
  if (targetTerminalId === -1) {
    for (var i = 0; i < 4; i++) {
      var container = document.getElementById('term-container-' + activeTabId + '-' + i);
      if (container && container.classList.contains('hidden-slot')) {
        targetTerminalId = i;
        container.classList.remove('hidden-slot');
        tab.visibleTerminalCount++;
        updateGridLayout();
        break;
      }
    }
  }

  // No available slot - create new tab
  if (targetTerminalId === -1) {
    vscode.postMessage({ command: 'createTab' });
    return;
  }

  // Delay terminal start to allow layout to settle
  var tid = targetTerminalId;
  setTimeout(function() {
    startTerminalWithProject(tid, projectPath, projectName, resume);
  }, 100);
}

// Add terminal button event listener
document.getElementById('add-terminal-btn').addEventListener('click', addTerminal);

function toggleFullscreen(terminalId) {
  var grid = document.querySelector('.grid[data-tab-id="' + activeTabId + '"]');
  if (!grid) return;
  var container = document.getElementById('term-container-' + activeTabId + '-' + terminalId);
  var btn = document.getElementById('fullscreen-' + activeTabId + '-' + terminalId);
  if (!container || !btn) return;
  var expandIcon = btn.querySelector('.expand-icon');
  var collapseIcon = btn.querySelector('.collapse-icon');

  if (currentFullscreen === terminalId) {
    // Exit fullscreen
    grid.classList.remove('has-fullscreen');
    container.classList.remove('fullscreen');
    expandIcon.style.display = '';
    collapseIcon.style.display = 'none';
    currentFullscreen = -1;
  } else {
    // Enter fullscreen (or switch to different terminal)
    if (currentFullscreen >= 0) {
      var prevContainer = document.getElementById('term-container-' + activeTabId + '-' + currentFullscreen);
      var prevBtn = document.getElementById('fullscreen-' + activeTabId + '-' + currentFullscreen);
      if (prevContainer) prevContainer.classList.remove('fullscreen');
      if (prevBtn) {
        prevBtn.querySelector('.expand-icon').style.display = '';
        prevBtn.querySelector('.collapse-icon').style.display = 'none';
      }
    }
    grid.classList.add('has-fullscreen');
    container.classList.add('fullscreen');
    expandIcon.style.display = 'none';
    collapseIcon.style.display = '';
    currentFullscreen = terminalId;
  }

  // Refit terminals after layout change
  setTimeout(fitAll, 50);
}

function initializeTerminal(i) {
  var tab = getActiveTab();
  if (!tab) return;

  if (tab.terminalInitialized[i]) {
    return; // Already initialized
  }

  var terminalId = i;
  var currentTabId = activeTabId;
  var container = document.getElementById('terminal-' + currentTabId + '-' + i);
  if (!container) return;
  container.innerHTML = ''; // Clear placeholder

  var term = new Terminal({
    theme: theme,
    fontSize: terminalFontSize,
    fontFamily: terminalFontFamily,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    disableStdin: false,
    cursorStyle: 'block',
    lineHeight: 1.2
  });

  var fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  term.open(container);

  // Register file link provider for clickable file paths
  term.registerLinkProvider({
    provideLinks: function(bufferLineNumber, callback) {
      var line = term.buffer.active.getLine(bufferLineNumber);
      if (!line) {
        callback(undefined);
        return;
      }
      var lineText = line.translateToString(true);
      var links = [];

      // Simple file path pattern: matches paths with extensions and optional :line:col
      // Examples: src/file.ts:10:5, ./foo.ts, /abs/path.js:42, file.tsx:10
      var fileRegex = /([.]{0,2}\/)?([\/\w.-]+\/)*[\w.-]+\.[a-zA-Z]{1,10}(:\d+)?(:\d+)?/g;

      var match;
      while ((match = fileRegex.exec(lineText)) !== null) {
        var fullMatch = match[0];

        // Skip URLs
        if (lineText.substring(Math.max(0, match.index - 10), match.index).includes('://')) continue;

        // Skip very short matches
        if (fullMatch.length < 3) continue;

        // Parse line:col from the match
        var parts = fullMatch.split(':');
        var filePath = parts[0];
        var lineNum = parts[1] ? parseInt(parts[1], 10) : undefined;
        var colNum = parts[2] ? parseInt(parts[2], 10) : undefined;

        // Skip if no extension
        if (!/\\.[a-zA-Z0-9]+$/.test(filePath)) continue;

        var matchStart = match.index;
        var matchEnd = matchStart + fullMatch.length;

        (function(fp, ln, cn) {
          links.push({
            range: {
              start: { x: matchStart + 1, y: bufferLineNumber + 1 },
              end: { x: matchEnd + 1, y: bufferLineNumber + 1 }
            },
            text: fullMatch,
            activate: function(event, text) {
              vscode.postMessage({
                command: 'openFile',
                filePath: fp,
                line: ln,
                column: cn,
                tabId: currentTabId,
                terminalId: terminalId
              });
            }
          });
        })(filePath, lineNum, colNum);
      }

      callback(links.length > 0 ? links : undefined);
    }
  });

  // Register URL link provider for http/https links
  term.registerLinkProvider({
    provideLinks: function(bufferLineNumber, callback) {
      var line = term.buffer.active.getLine(bufferLineNumber);
      if (!line) {
        callback(undefined);
        return;
      }
      var lineText = line.translateToString(true);
      var links = [];

      // Match URLs
      var urlRegex = /https?:\/\/[^\s<>"{}|\\^[\]]+/g;

      var match;
      while ((match = urlRegex.exec(lineText)) !== null) {
        var url = match[0].replace(/[.,;:!?)]+$/, ''); // Trim trailing punctuation
        var matchStart = match.index;
        var matchEnd = matchStart + url.length;

        (function(u) {
          links.push({
            range: {
              start: { x: matchStart + 1, y: bufferLineNumber + 1 },
              end: { x: matchEnd + 1, y: bufferLineNumber + 1 }
            },
            text: url,
            activate: function(event, text) {
              vscode.postMessage({
                command: 'openUrl',
                url: u
              });
            }
          });
        })(url);
      }

      callback(links.length > 0 ? links : undefined);
    }
  });

  // Helper to detect links at a position
  function detectLinksAtPosition(x, y) {
    var line = term.buffer.active.getLine(y);
    if (!line) return [];

    var lineText = line.translateToString(true);
    var links = [];

    // File paths
    var fileRegex = /([.]{0,2}\/)?([\/\w.-]+\/)*[\w.-]+\.[a-zA-Z]{1,10}(:\d+)?(:\d+)?/g;
    var match;
    while ((match = fileRegex.exec(lineText)) !== null) {
      var fullMatch = match[0];
      if (fullMatch.length < 3) continue;
      if (lineText.substring(Math.max(0, match.index - 10), match.index).includes('://')) continue;

      var parts = fullMatch.split(':');
      var filePath = parts[0];
      if (!/\.[a-zA-Z0-9]+$/.test(filePath)) continue;

      var startX = match.index;
      var endX = startX + fullMatch.length;

      if (x >= startX && x < endX) {
        links.push({
          type: 'file',
          path: filePath,
          line: parts[1] ? parseInt(parts[1], 10) : undefined,
          column: parts[2] ? parseInt(parts[2], 10) : undefined
        });
      }
    }

    // URLs
    var urlRegex = /https?:\/\/[^\s<>"{}|\\^[\]]+/g;
    while ((match = urlRegex.exec(lineText)) !== null) {
      var url = match[0].replace(/[.,;:!?)]+$/, '');
      var startX = match.index;
      var endX = startX + url.length;

      if (x >= startX && x < endX) {
        links.push({ type: 'url', url: url });
      }
    }

    return links;
  }

  // Get cell dimensions helper
  function getCellDimensions() {
    try {
      return {
        width: term._core._renderService.dimensions.css.cell.width,
        height: term._core._renderService.dimensions.css.cell.height
      };
    } catch (e) {
      return null;
    }
  }

  // Convert mouse position to terminal coordinates
  function getTerminalPosition(e, element) {
    var rect = element.getBoundingClientRect();
    var dims = getCellDimensions();
    if (!dims) return null;

    var x = Math.floor((e.clientX - rect.left) / dims.width);
    var y = Math.floor((e.clientY - rect.top) / dims.height);
    var bufferY = y + term.buffer.active.viewportY;

    return { x: x, y: y, bufferY: bufferY };
  }

  // Wait for xterm to fully render, then attach handlers to the screen element
  setTimeout(function() {
    var xtermScreen = container.querySelector('.xterm-screen');
    if (!xtermScreen) return;

    // Hover handler - change cursor when over links
    xtermScreen.addEventListener('mousemove', function(e) {
      var pos = getTerminalPosition(e, xtermScreen);
      if (!pos) return;

      var links = detectLinksAtPosition(pos.x, pos.bufferY);
      xtermScreen.style.cursor = links.length > 0 ? 'pointer' : 'text';
    });

    xtermScreen.addEventListener('mouseleave', function() {
      xtermScreen.style.cursor = 'text';
    });

    // Click handler for links
    xtermScreen.addEventListener('mousedown', function(e) {
      // Only handle left clicks
      if (e.button !== 0) return;

      var pos = getTerminalPosition(e, xtermScreen);
      if (!pos) return;

      var links = detectLinksAtPosition(pos.x, pos.bufferY);

      if (links.length > 0) {
        var link = links[0];

        // Prevent xterm from starting text selection
        e.preventDefault();
        e.stopPropagation();

        if (link.type === 'file') {
          vscode.postMessage({
            command: 'openFile',
            filePath: link.path,
            line: link.line,
            column: link.column,
            tabId: currentTabId,
            terminalId: terminalId
          });
        } else if (link.type === 'url') {
          vscode.postMessage({
            command: 'openUrl',
            url: link.url
          });
        }
      }
    });
  }, 100);

  tab.terminals[i] = term;
  tab.fitAddons[i] = fitAddon;
  tab.terminalInitialized[i] = true;

  // Send input to extension
  term.onData(function(data) {
    vscode.postMessage({
      command: 'input',
      tabId: currentTabId,
      terminalId: terminalId,
      data: data
    });
  });

  // Send resize to extension
  term.onResize(function(size) {
    vscode.postMessage({
      command: 'resize',
      tabId: currentTabId,
      terminalId: terminalId,
      cols: size.cols,
      rows: size.rows
    });
  });

  // Fit after initialization - multiple attempts to handle layout timing
  var doFit = function() {
    fitAddon.fit();
    var dims = fitAddon.proposeDimensions();
    if (dims) {
      vscode.postMessage({
        command: 'resize',
        tabId: currentTabId,
        terminalId: terminalId,
        cols: dims.cols,
        rows: dims.rows
      });
    }
  };

  // Initial fit after short delay
  setTimeout(function() {
    doFit();
    term.focus();
  }, 50);

  // Second fit to catch any layout changes
  setTimeout(doFit, 150);

  // Third fit for good measure
  setTimeout(doFit, 300);
}

// Fit all initialized terminals
function fitAll() {
  var tab = getActiveTab();
  if (!tab) return;

  tab.fitAddons.forEach(function(addon, i) {
    if (addon && tab.terminalInitialized[i]) {
      try {
        addon.fit();
        var dims = addon.proposeDimensions();
        if (dims) {
          vscode.postMessage({
            command: 'resize',
            tabId: activeTabId,
            terminalId: i,
            cols: dims.cols,
            rows: dims.rows
          });
        }
      } catch (e) {}
    }
  });
}

// Fit on resize
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(fitAll, 50);
});

// ResizeObserver for more reliable resize detection
const resizeObserver = new ResizeObserver(() => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(fitAll, 50);
});
document.querySelectorAll('.terminal-wrapper').forEach(el => {
  resizeObserver.observe(el);
});

// Store received config for later terminal initialization
let receivedConfig = null;

// Handle messages from extension
window.addEventListener('message', function(event) {
  var message = event.data;
  var msgTabId = message.tabId || activeTabId;
  var msgTab = getTab(msgTabId);

  switch (message.command) {
    case 'projects':
      updateProjectSelectors(message.projects);
      break;
    case 'terminalConfig':
      receivedConfig = message.config;
      applyTerminalConfig(message.config);
      break;
    case 'output':
      if (msgTab && msgTab.terminals[message.terminalId]) {
        var outTerm = msgTab.terminals[message.terminalId];
        // Check if user is at bottom before writing
        var isAtBottom = outTerm.buffer.active.viewportY >= outTerm.buffer.active.baseY;
        outTerm.write(message.data);
        // Only auto-scroll if user was already at bottom
        if (isAtBottom) {
          outTerm.scrollToBottom();
        }
        // Restore saved title after restart
        if (msgTab.savedTitles && msgTab.savedTitles[message.terminalId]) {
          var titleEl = document.getElementById('terminal-title-' + msgTabId + '-' + message.terminalId);
          if (titleEl && titleEl.textContent === 'Restarting...') {
            titleEl.textContent = msgTab.savedTitles[message.terminalId];
            delete msgTab.savedTitles[message.terminalId];
          }
        }
      }
      // Mark tab as having activity if not active
      if (msgTabId !== activeTabId) {
        var tabBtn = document.querySelector('.tab-button[data-tab-id="' + msgTabId + '"]');
        if (tabBtn) tabBtn.classList.add('has-activity');
      }
      break;
    case 'clear':
      if (msgTab && msgTab.terminals[message.terminalId]) {
        msgTab.terminals[message.terminalId].clear();
        msgTab.terminals[message.terminalId].reset();
      }
      break;
    case 'error':
      if (msgTab && msgTab.terminals[message.terminalId]) {
        msgTab.terminals[message.terminalId].write('\x1b[31m' + message.message + '\x1b[0m\r\n');
      }
      break;
    case 'killed':
      var killedTabId = message.tabId || activeTabId;
      var killedTab = getTab(killedTabId);
      var killedStatusEl = document.getElementById('status-' + killedTabId + '-' + message.terminalId);
      if (killedStatusEl) killedStatusEl.classList.remove('active', 'busy');
      // Reset terminal title
      var killedTitle = document.getElementById('terminal-title-' + killedTabId + '-' + message.terminalId);
      if (killedTitle) {
        killedTitle.textContent = 'Terminal ' + (message.terminalId + 1);
        killedTitle.classList.add('empty');
      }
      // Clear project tracking
      if (killedTab) killedTab.terminalProjects[message.terminalId] = '';

      // Exit fullscreen if this terminal was fullscreened (only for active tab)
      if (killedTabId === activeTabId && currentFullscreen === message.terminalId) {
        toggleFullscreen(message.terminalId);
      }

      // Hide this terminal and let remaining terminals expand (only for active tab)
      if (killedTabId === activeTabId) {
        removeTerminalSlot(message.terminalId);
      }
      break;
    case 'restarting':
      // Clear terminal but keep the slot (for restart)
      var restartTabId = message.tabId || activeTabId;
      var restartTab = getTab(restartTabId);
      if (restartTab && restartTab.terminals[message.terminalId]) {
        restartTab.terminals[message.terminalId].clear();
      }
      // Update status to show restarting
      var restartStatusEl = document.getElementById('status-' + restartTabId + '-' + message.terminalId);
      if (restartStatusEl) {
        restartStatusEl.classList.remove('active', 'busy');
      }
      // Save current title and show restarting message
      var restartTitle = document.getElementById('terminal-title-' + restartTabId + '-' + message.terminalId);
      if (restartTitle) {
        // Store the project name for restoration
        if (restartTab) {
          restartTab.savedTitles = restartTab.savedTitles || {};
          restartTab.savedTitles[message.terminalId] = restartTitle.textContent;
        }
        restartTitle.textContent = 'Restarting...';
      }
      break;
    case 'status':
      var statusTabId = message.tabId || activeTabId;
      var statusEl = document.getElementById('status-' + statusTabId + '-' + message.terminalId);
      if (statusEl) {
        if (message.status === 'busy') {
          statusEl.classList.remove('active');
          statusEl.classList.add('busy');
        } else {
          statusEl.classList.remove('busy');
          statusEl.classList.add('active');
        }
      }
      // Mark tab as having activity if not active
      if (statusTabId !== activeTabId && message.status === 'busy') {
        var tabBtn = document.querySelector('.tab-button[data-tab-id="' + statusTabId + '"]');
        if (tabBtn) tabBtn.classList.add('has-activity');
      }
      break;
    case 'dropResolved':
      // Resolved file paths from extension, input them into terminal
      var dropTabId = message.tabId || activeTabId;
      var dropTab = getTab(dropTabId);
      if (message.paths && dropTab && dropTab.terminalInitialized[message.terminalId]) {
        vscode.postMessage({
          command: 'input',
          tabId: dropTabId,
          terminalId: message.terminalId,
          data: message.paths
        });
        if (dropTab.terminals[message.terminalId]) {
          dropTab.terminals[message.terminalId].focus();
        }
      }
      break;
    case 'refresh':
      // Exit fullscreen if active
      if (currentFullscreen >= 0) {
        var grid = document.querySelector('.grid[data-tab-id="' + activeTabId + '"]');
        var prevContainer = document.getElementById('term-container-' + activeTabId + '-' + currentFullscreen);
        var prevBtn = document.getElementById('fullscreen-' + activeTabId + '-' + currentFullscreen);
        if (grid) grid.classList.remove('has-fullscreen');
        if (prevContainer) prevContainer.classList.remove('fullscreen');
        if (prevBtn) {
          prevBtn.querySelector('.expand-icon').style.display = '';
          prevBtn.querySelector('.collapse-icon').style.display = 'none';
        }
        currentFullscreen = -1;
      }
      // Reset all terminals in active tab
      var refreshTab = getActiveTab();
      if (refreshTab) {
        for (var i = 0; i < 4; i++) {
          if (refreshTab.terminals[i]) {
            refreshTab.terminals[i].clear();
            refreshTab.terminals[i].reset();
          }
          refreshTab.terminalInitialized[i] = false;
          refreshTab.terminalProjects[i] = '';
          var termEl = document.getElementById('terminal-' + activeTabId + '-' + i);
          if (termEl) {
            termEl.innerHTML = '<div class="terminal-placeholder"><span class="terminal-placeholder-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span><span class="terminal-placeholder-text">Select a project and click "Add Terminal"</span></div>';
          }
          // Reset terminal title
          var titleEl = document.getElementById('terminal-title-' + activeTabId + '-' + i);
          if (titleEl) {
            titleEl.textContent = 'Terminal ' + (i + 1);
            titleEl.classList.add('empty');
          }
          var statusEl = document.getElementById('status-' + activeTabId + '-' + i);
          if (statusEl) statusEl.classList.remove('active', 'busy');
          // Hide terminals 1-3
          if (i > 0) {
            var termContainer = document.getElementById('term-container-' + activeTabId + '-' + i);
            if (termContainer) termContainer.classList.add('hidden-slot');
          }
        }
        refreshTab.visibleTerminalCount = 1;
      }
      // Reset global controls
      document.getElementById('global-project-select').value = '';
      document.getElementById('global-resume').checked = false;
      updateGridLayout();
      break;
    case 'tabCreated':
      createTab(message.tabId);
      nextTabId = message.tabId + 1;
      break;
    case 'tabClosed':
      removeTab(message.tabId);
      if (message.newActiveTabId) {
        switchTabUI(message.newActiveTabId);
      }
      break;
    case 'tabSwitched':
      switchTabUI(message.tabId);
      break;
  }
});

function applyTerminalConfig(config) {
  // Apply theme class to body for CSS styling
  document.body.classList.remove('vscode-dark', 'vscode-light', 'vscode-high-contrast');
  if (config.isDark) {
    document.body.classList.add('vscode-dark');
  } else {
    document.body.classList.add('vscode-light');
  }

  // Get default colors based on theme
  const defaultBg = config.isDark ? '#1e1e1e' : '#ffffff';
  const defaultFg = config.isDark ? '#cccccc' : '#333333';
  const defaultCursor = config.isDark ? '#ffffff' : '#333333';
  const defaultSelection = config.isDark ? '#264f78' : '#add6ff';

  // Build new theme from received config, using theme-appropriate fallbacks
  const newTheme = {
    background: config.colors.background || defaultBg,
    foreground: config.colors.foreground || defaultFg,
    cursor: config.colors.cursor || defaultCursor,
    cursorAccent: config.colors.cursorAccent || (config.isDark ? '#000000' : '#ffffff'),
    selectionBackground: config.colors.selectionBackground || defaultSelection,
    black: config.colors.black || (config.isDark ? '#000000' : '#000000'),
    red: config.colors.red || (config.isDark ? '#cd3131' : '#cd3131'),
    green: config.colors.green || (config.isDark ? '#0dbc79' : '#00bc00'),
    yellow: config.colors.yellow || (config.isDark ? '#e5e510' : '#949800'),
    blue: config.colors.blue || (config.isDark ? '#2472c8' : '#0451a5'),
    magenta: config.colors.magenta || (config.isDark ? '#bc3fbc' : '#bc05bc'),
    cyan: config.colors.cyan || (config.isDark ? '#11a8cd' : '#0598bc'),
    white: config.colors.white || (config.isDark ? '#e5e5e5' : '#555555'),
    brightBlack: config.colors.brightBlack || (config.isDark ? '#666666' : '#666666'),
    brightRed: config.colors.brightRed || (config.isDark ? '#f14c4c' : '#cd3131'),
    brightGreen: config.colors.brightGreen || (config.isDark ? '#23d18b' : '#14ce14'),
    brightYellow: config.colors.brightYellow || (config.isDark ? '#f5f543' : '#b5ba00'),
    brightBlue: config.colors.brightBlue || (config.isDark ? '#3b8eea' : '#0451a5'),
    brightMagenta: config.colors.brightMagenta || (config.isDark ? '#d670d6' : '#bc05bc'),
    brightCyan: config.colors.brightCyan || (config.isDark ? '#29b8db' : '#0598bc'),
    brightWhite: config.colors.brightWhite || (config.isDark ? '#ffffff' : '#a5a5a5')
  };

  // Update global theme for new terminals
  Object.assign(theme, newTheme);

  // Apply background color to CSS elements
  const bgColor = newTheme.background;
  document.querySelectorAll('.terminal-container').forEach(el => {
    el.style.background = bgColor;
  });
  document.querySelectorAll('.terminal-wrapper').forEach(el => {
    el.style.background = bgColor;
  });
  document.querySelectorAll('.xterm').forEach(el => {
    el.style.background = bgColor;
  });
  document.body.style.background = bgColor;

  // Update existing terminals with new theme (all tabs)
  Object.keys(tabState).forEach(function(tabIdStr) {
    var tabData = tabState[tabIdStr];
    if (tabData && tabData.terminals) {
      tabData.terminals.forEach(function(term, i) {
        if (term && tabData.terminalInitialized[i]) {
          term.options.theme = newTheme;
          if (config.fontFamily) {
            term.options.fontFamily = config.fontFamily;
          }
          if (config.fontSize) {
            term.options.fontSize = config.fontSize;
          }
          if (config.lineHeight) {
            term.options.lineHeight = config.lineHeight;
          }
          if (config.cursorStyle) {
            term.options.cursorStyle = config.cursorStyle;
          }
          term.options.cursorBlink = config.cursorBlink !== false;
        }
      });
    }
  });
}

function updateProjectSelectors(projects) {
  const select = document.getElementById('global-project-select');
  const currentValue = select.value;

  // Clear existing options except the first one
  while (select.options.length > 1) {
    select.remove(1);
  }

  // Add project options
  projects.forEach(project => {
    const option = document.createElement('option');
    option.value = project.path;
    option.textContent = project.name;
    select.appendChild(option);
  });

  // Restore previous selection if still valid
  if (currentValue) {
    select.value = currentValue;
  }

  // Update add button state based on selection
  updateAddButtonState();
}

// Add tab button event listener
document.getElementById('add-tab-btn').addEventListener('click', function() {
  vscode.postMessage({ command: 'createTab' });
});

// Attach listener to initial tab button (Tab 1)
const initialTabBtn = document.querySelector('.tab-button[data-tab-id="1"]');
if (initialTabBtn) {
  attachTabButtonListeners(initialTabBtn);
}

// Keyboard shortcuts for tab management
document.addEventListener('keydown', function(e) {
  // Ctrl/Cmd+T: New tab
  if ((e.ctrlKey || e.metaKey) && e.key === 't') {
    e.preventDefault();
    vscode.postMessage({ command: 'createTab' });
  }
  // Ctrl/Cmd+W: Close current tab
  if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
    e.preventDefault();
    closeTab(activeTabId);
  }
  // Ctrl+Tab: Next tab
  if (e.ctrlKey && e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    var tabIds = Object.keys(tabState).map(Number).sort(function(a, b) { return a - b; });
    var currentIndex = tabIds.indexOf(activeTabId);
    var nextIndex = (currentIndex + 1) % tabIds.length;
    switchTab(tabIds[nextIndex]);
  }
  // Ctrl+Shift+Tab: Previous tab
  if (e.ctrlKey && e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    var tabIds = Object.keys(tabState).map(Number).sort(function(a, b) { return a - b; });
    var currentIndex = tabIds.indexOf(activeTabId);
    var prevIndex = (currentIndex - 1 + tabIds.length) % tabIds.length;
    switchTab(tabIds[prevIndex]);
  }
});

// Tell extension we're ready
vscode.postMessage({ command: 'ready' });
