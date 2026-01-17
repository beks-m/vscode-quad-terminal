# Tabs Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add multi-tab support where each tab is an independent quad terminal instance.

**Architecture:** Wrap existing terminal state in a `TabState` interface. Provider maintains a `Map<number, TabState>` for all tabs. Webview mirrors this with a per-tab grid that shows/hides on tab switch.

**Tech Stack:** TypeScript, VS Code Webview API, node-pty, xterm.js

---

## Task 1: Add TabState Interface and Provider Properties

**Files:**
- Modify: `src/extension.ts:6-12` (constants)
- Modify: `src/extension.ts:40-47` (provider properties)

**Step 1: Add TabState interface after imports**

After line 4, add:

```typescript
interface TabState {
  ptyProcesses: Map<number, pty.IPty>;
  terminalProjects: Map<number, string>;
  idleTimers: Map<number, NodeJS.Timeout>;
  terminalBusy: Map<number, boolean>;
  claudeCommandTimeouts: Map<number, NodeJS.Timeout>;
}
```

**Step 2: Update provider properties**

Replace the existing Maps in the provider class (lines 42-46) with:

```typescript
  private tabs: Map<number, TabState> = new Map();
  private activeTabId: number = 1;
  private nextTabId: number = 2;
```

**Step 3: Add helper to create empty TabState**

Add after the constructor:

```typescript
  private createTabState(): TabState {
    return {
      ptyProcesses: new Map(),
      terminalProjects: new Map(),
      idleTimers: new Map(),
      terminalBusy: new Map(),
      claudeCommandTimeouts: new Map()
    };
  }
```

**Step 4: Initialize first tab**

In `resolveWebviewView`, after setting `this._view = webviewView`, add:

```typescript
    // Initialize first tab
    if (this.tabs.size === 0) {
      this.tabs.set(1, this.createTabState());
    }
```

**Step 5: Compile to verify no errors**

Run: `npm run compile`
Expected: Successful compilation (warnings about unused variables expected)

**Step 6: Commit**

```bash
git add src/extension.ts
git commit -m "feat(tabs): add TabState interface and provider properties"
```

---

## Task 2: Refactor Terminal Methods to Use TabState

**Files:**
- Modify: `src/extension.ts` (multiple methods)

**Step 1: Add helper to get current tab state**

Add after `createTabState`:

```typescript
  private getTabState(tabId: number): TabState | undefined {
    return this.tabs.get(tabId);
  }

  private getActiveTabState(): TabState | undefined {
    return this.tabs.get(this.activeTabId);
  }
```

**Step 2: Update startTerminalWithProject signature and body**

Change method signature from:
```typescript
private startTerminalWithProject(terminalId: number, projectPath: string, resume: boolean = false)
```
To:
```typescript
private startTerminalWithProject(tabId: number, terminalId: number, projectPath: string, resume: boolean = false)
```

Update the method body to use `tabState`:

```typescript
  private startTerminalWithProject(tabId: number, terminalId: number, projectPath: string, resume: boolean = false) {
    const tabState = this.getTabState(tabId);
    if (!tabState) return;

    // Clean up existing resources for this terminal
    this.cleanupTerminal(tabId, terminalId);

    // Clear the terminal in webview
    this.sendToWebview('clear', { tabId, terminalId });

    const shell = os.platform() === 'win32'
      ? 'powershell.exe'
      : process.env.SHELL || '/bin/zsh';

    try {
      const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: projectPath,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor'
        } as { [key: string]: string }
      });

      tabState.ptyProcesses.set(terminalId, ptyProcess);
      tabState.terminalProjects.set(terminalId, projectPath);

      // Send PTY output to webview
      ptyProcess.onData((data: string) => {
        this.sendToWebview('output', { tabId, terminalId, data });
        this.markBusy(tabId, terminalId);
      });

      // Handle PTY exit
      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`[QuadTerminal] Tab ${tabId} Terminal ${terminalId} exited with code ${exitCode}`);
        this.cleanupTerminal(tabId, terminalId);
        this.sendToWebview('killed', { tabId, terminalId });
      });

      // Auto-run claude after shell init
      const timeout = setTimeout(() => {
        if (tabState.ptyProcesses.has(terminalId)) {
          const claudeCmd = resume ? 'claude --dangerously-skip-permissions --resume\r' : 'claude --dangerously-skip-permissions\r';
          ptyProcess.write(claudeCmd);
        }
        tabState.claudeCommandTimeouts.delete(terminalId);
      }, SHELL_INIT_DELAY_MS);
      tabState.claudeCommandTimeouts.set(terminalId, timeout);

    } catch (error) {
      console.error(`[QuadTerminal] Failed to create PTY process tab ${tabId} terminal ${terminalId}:`, error);
      this.sendToWebview('error', {
        tabId,
        terminalId,
        message: `Failed to start terminal: ${error}`
      });
    }
  }
```

**Step 3: Update cleanupTerminal**

Change from:
```typescript
private cleanupTerminal(terminalId: number)
```
To:
```typescript
private cleanupTerminal(tabId: number, terminalId: number)
```

```typescript
  private cleanupTerminal(tabId: number, terminalId: number) {
    const tabState = this.getTabState(tabId);
    if (!tabState) return;

    const existingPty = tabState.ptyProcesses.get(terminalId);
    if (existingPty) {
      existingPty.kill();
      tabState.ptyProcesses.delete(terminalId);
    }

    this.clearIdleTimer(tabId, terminalId);

    const cmdTimeout = tabState.claudeCommandTimeouts.get(terminalId);
    if (cmdTimeout) {
      clearTimeout(cmdTimeout);
      tabState.claudeCommandTimeouts.delete(terminalId);
    }

    tabState.terminalBusy.delete(terminalId);
    tabState.terminalProjects.delete(terminalId);
  }
```

**Step 4: Update handleInput**

```typescript
  private handleInput(tabId: number, terminalId: number, data: string) {
    const tabState = this.getTabState(tabId);
    const ptyProcess = tabState?.ptyProcesses.get(terminalId);
    if (ptyProcess) {
      ptyProcess.write(data);
    }
  }
```

**Step 5: Update handleResize**

```typescript
  private handleResize(tabId: number, terminalId: number, cols: number, rows: number) {
    const tabState = this.getTabState(tabId);
    const ptyProcess = tabState?.ptyProcesses.get(terminalId);
    if (ptyProcess && cols > 0 && rows > 0) {
      try {
        ptyProcess.resize(cols, rows);
      } catch (e) {
        // Ignore resize errors
      }
    }
  }
```

**Step 6: Update killTerminal**

```typescript
  private killTerminal(tabId: number, terminalId: number) {
    const tabState = this.getTabState(tabId);
    const ptyProcess = tabState?.ptyProcesses.get(terminalId);
    if (ptyProcess) {
      this.cleanupTerminal(tabId, terminalId);
      this.sendToWebview('killed', { tabId, terminalId });
    }
  }
```

**Step 7: Update markBusy and clearIdleTimer**

```typescript
  private markBusy(tabId: number, terminalId: number) {
    const tabState = this.getTabState(tabId);
    if (!tabState) return;

    this.clearIdleTimer(tabId, terminalId);

    if (!tabState.terminalBusy.get(terminalId)) {
      tabState.terminalBusy.set(terminalId, true);
      this.sendToWebview('status', { tabId, terminalId, status: 'busy' });
    }

    const timer = setTimeout(() => {
      tabState.terminalBusy.set(terminalId, false);
      this.sendToWebview('status', { tabId, terminalId, status: 'idle' });
      tabState.idleTimers.delete(terminalId);
    }, IDLE_TIMEOUT_MS);
    tabState.idleTimers.set(terminalId, timer);
  }

  private clearIdleTimer(tabId: number, terminalId: number) {
    const tabState = this.getTabState(tabId);
    const timer = tabState?.idleTimers.get(terminalId);
    if (timer) {
      clearTimeout(timer);
      tabState?.idleTimers.delete(terminalId);
    }
  }
```

**Step 8: Update openFileInEditor**

Change `terminalId?: number` to `tabId?: number, terminalId?: number` and update the body to get projectPath from the tab state.

**Step 9: Update resolveDropData**

Add `tabId: number` as first parameter and use it throughout.

**Step 10: Update pickFilesForTerminal**

Add `tabId: number` as first parameter.

**Step 11: Update message handlers in resolveWebviewView**

Update the switch statement to extract `tabId` from messages and pass to methods:

```typescript
case 'selectProject':
  if (this.isValidTerminalId(message.terminalId)) {
    const tabId = message.tabId || this.activeTabId;
    this.startTerminalWithProject(tabId, message.terminalId, message.projectPath, message.resume);
  }
  break;
case 'input':
  if (this.isValidTerminalId(message.terminalId)) {
    const tabId = message.tabId || this.activeTabId;
    this.handleInput(tabId, message.terminalId, message.data);
  }
  break;
case 'resize':
  if (this.isValidTerminalId(message.terminalId)) {
    const tabId = message.tabId || this.activeTabId;
    this.handleResize(tabId, message.terminalId, message.cols, message.rows);
  }
  break;
case 'kill':
  if (this.isValidTerminalId(message.terminalId)) {
    const tabId = message.tabId || this.activeTabId;
    this.killTerminal(tabId, message.terminalId);
  }
  break;
case 'resolveDrop':
  if (this.isValidTerminalId(message.terminalId)) {
    const tabId = message.tabId || this.activeTabId;
    this.resolveDropData(tabId, message.terminalId, message.data);
  }
  break;
case 'openFile':
  this.openFileInEditor(message.filePath, message.line, message.column, message.tabId, message.terminalId);
  break;
case 'pickFiles':
  this.pickFilesForTerminal(message.tabId || this.activeTabId, message.terminalId);
  break;
```

**Step 12: Update disposeAllResources**

```typescript
  private disposeAllResources() {
    for (const [tabId, tabState] of this.tabs) {
      for (const [terminalId, ptyProcess] of tabState.ptyProcesses) {
        ptyProcess.kill();
      }
      for (const timer of tabState.idleTimers.values()) {
        clearTimeout(timer);
      }
      for (const timeout of tabState.claudeCommandTimeouts.values()) {
        clearTimeout(timeout);
      }
    }
    this.tabs.clear();
    this.tabs.set(1, this.createTabState());
    this.activeTabId = 1;
    this.nextTabId = 2;
  }
```

**Step 13: Compile to verify**

Run: `npm run compile`
Expected: Successful compilation

**Step 14: Commit**

```bash
git add src/extension.ts
git commit -m "refactor(tabs): update terminal methods to use TabState"
```

---

## Task 3: Add Tab Management Methods

**Files:**
- Modify: `src/extension.ts`

**Step 1: Add createTab method**

```typescript
  private createTab(): number {
    const newTabId = this.nextTabId++;
    this.tabs.set(newTabId, this.createTabState());
    this.activeTabId = newTabId;
    this.sendToWebview('tabCreated', { tabId: newTabId });
    return newTabId;
  }
```

**Step 2: Add switchTab method**

```typescript
  private switchTab(tabId: number) {
    if (this.tabs.has(tabId)) {
      this.activeTabId = tabId;
      this.sendToWebview('tabSwitched', { tabId });
    }
  }
```

**Step 3: Add closeTab method with confirmation**

```typescript
  private async closeTab(tabId: number) {
    const tabState = this.getTabState(tabId);
    if (!tabState) return;

    // Check if tab has active terminals
    if (tabState.ptyProcesses.size > 0) {
      const answer = await vscode.window.showWarningMessage(
        `Tab ${tabId} has ${tabState.ptyProcesses.size} active terminal(s). Close anyway?`,
        { modal: true },
        'Yes', 'No'
      );
      if (answer !== 'Yes') return;
    }

    // Kill all terminals in this tab
    for (const terminalId of tabState.ptyProcesses.keys()) {
      this.cleanupTerminal(tabId, terminalId);
    }

    // Remove tab
    this.tabs.delete(tabId);

    // If this was the active tab, switch to another
    if (this.activeTabId === tabId) {
      const remainingTabs = Array.from(this.tabs.keys());
      if (remainingTabs.length > 0) {
        this.activeTabId = remainingTabs[0];
      } else {
        // Create new tab if none left
        this.tabs.set(1, this.createTabState());
        this.activeTabId = 1;
        this.nextTabId = 2;
      }
    }

    this.sendToWebview('tabClosed', { tabId, newActiveTabId: this.activeTabId });
  }
```

**Step 4: Add message handlers for tab operations**

In the message switch statement:

```typescript
case 'createTab':
  this.createTab();
  break;
case 'switchTab':
  this.switchTab(message.tabId);
  break;
case 'closeTab':
  this.closeTab(message.tabId);
  break;
```

**Step 5: Compile to verify**

Run: `npm run compile`
Expected: Successful compilation

**Step 6: Commit**

```bash
git add src/extension.ts
git commit -m "feat(tabs): add tab management methods"
```

---

## Task 4: Add Tab Bar CSS

**Files:**
- Modify: `src/extension.ts` (CSS section ~520-960)

**Step 1: Add tab bar CSS**

After the `.control-panel-section` styles (around line 560), add:

```css
    /* Tab Bar */
    .tab-bar {
      display: flex;
      align-items: center;
      gap: 2px;
      margin-right: 8px;
      padding-right: 8px;
      border-right: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border, #333));
    }
    .tab-button {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--vscode-tab-inactiveForeground, #969696);
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.12s ease;
      position: relative;
    }
    .tab-button:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.4));
      color: var(--vscode-foreground, #ccc);
    }
    .tab-button.active {
      background: var(--vscode-tab-activeBackground, #1e1e1e);
      color: var(--vscode-tab-activeForeground, #fff);
      border-bottom: 2px solid var(--vscode-focusBorder, #007acc);
    }
    .tab-button .tab-close {
      display: none;
      width: 14px;
      height: 14px;
      padding: 0;
      margin-left: 2px;
      background: transparent;
      border: none;
      border-radius: 3px;
      color: inherit;
      cursor: pointer;
      align-items: center;
      justify-content: center;
    }
    .tab-button:hover .tab-close,
    .tab-button.active .tab-close {
      display: flex;
    }
    .tab-button .tab-close:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.6));
      color: var(--vscode-errorForeground, #f48771);
    }
    .tab-button .tab-close svg {
      width: 10px;
      height: 10px;
      fill: currentColor;
    }
    .tab-button .tab-activity {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vscode-terminal-ansiYellow, #e5e510);
      display: none;
    }
    .tab-button.has-activity .tab-activity {
      display: block;
      animation: pulse 1.2s ease-in-out infinite;
    }
    .add-tab-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--vscode-descriptionForeground, #888);
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .add-tab-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.4));
      color: var(--vscode-foreground, #ccc);
    }
    .add-tab-btn svg {
      width: 14px;
      height: 14px;
      fill: currentColor;
    }
```

**Step 2: Add light theme tab styles**

After the existing light theme styles (around line 955):

```css
    body.vscode-light .tab-button {
      color: var(--vscode-tab-inactiveForeground, #6e6e6e);
    }
    body.vscode-light .tab-button.active {
      background: var(--vscode-tab-activeBackground, #ffffff);
      color: var(--vscode-tab-activeForeground, #333333);
    }
    body.vscode-light .tab-bar {
      border-right-color: var(--vscode-editorGroup-border, #e7e7e7);
    }
```

**Step 3: Compile to verify**

Run: `npm run compile`
Expected: Successful compilation

**Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "feat(tabs): add tab bar CSS styles"
```

---

## Task 5: Add Tab Bar HTML

**Files:**
- Modify: `src/extension.ts` (HTML section ~965-990)

**Step 1: Update control panel HTML**

Replace the control panel section (lines ~968-985) with:

```html
    <!-- Control Panel -->
    <div class="control-panel">
      <div class="tab-bar" id="tab-bar">
        <button class="tab-button active" data-tab-id="1">
          <span class="tab-label">Tab 1</span>
          <span class="tab-activity"></span>
          <button class="tab-close" title="Close tab">
            <svg viewBox="0 0 16 16"><path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z"/></svg>
          </button>
        </button>
        <button class="add-tab-btn" id="add-tab-btn" title="New tab">
          <svg viewBox="0 0 16 16"><path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/></svg>
        </button>
      </div>
      <div class="control-panel-section">
        <span class="control-label">Project</span>
        <select class="project-select" id="global-project-select">
          <option value="">Select project...</option>
        </select>
      </div>
      <label class="resume-label" id="global-resume-label" title="Resume previous Claude session">
        <input type="checkbox" class="resume-checkbox" id="global-resume">
        <span>Resume session</span>
      </label>
      <div class="control-panel-divider"></div>
      <button class="add-terminal-btn" id="add-terminal-btn" title="Add terminal with selected project" disabled>
        <svg viewBox="0 0 16 16"><path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/></svg>
        <span>Add Terminal</span>
      </button>
      <span class="terminal-count" id="terminal-count">1 / 4</span>
    </div>
```

**Step 2: Wrap grid in tab container**

Update the grid container section to include a data-tab-id attribute:

```html
    <!-- Grid Container -->
    <div class="grid-container">
      <div class="grid terminals-1" data-tab-id="1">
```

**Step 3: Compile to verify**

Run: `npm run compile`
Expected: Successful compilation

**Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "feat(tabs): add tab bar HTML structure"
```

---

## Task 6: Add Tab State Management in Webview JavaScript

**Files:**
- Modify: `src/extension.ts` (JavaScript section ~1104-2070)

**Step 1: Replace flat terminal arrays with tab-based structure**

Replace:
```javascript
    const terminals = [];
    const fitAddons = [];
    const terminalInitialized = [false, false, false, false];
    // ...
    const terminalProjects = ['', '', '', ''];
```

With:
```javascript
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
```

**Step 2: Add tab creation function**

```javascript
    function createTab(tabId) {
      tabState[tabId] = {
        terminals: [],
        fitAddons: [],
        terminalInitialized: [false, false, false, false],
        terminalProjects: ['', '', '', ''],
        visibleTerminalCount: 1
      };

      // Create tab button
      const tabBar = document.getElementById('tab-bar');
      const addTabBtn = document.getElementById('add-tab-btn');

      const tabBtn = document.createElement('button');
      tabBtn.className = 'tab-button';
      tabBtn.dataset.tabId = tabId;
      tabBtn.innerHTML = \`
        <span class="tab-label">Tab \${tabId}</span>
        <span class="tab-activity"></span>
        <button class="tab-close" title="Close tab">
          <svg viewBox="0 0 16 16"><path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z"/></svg>
        </button>
      \`;
      tabBar.insertBefore(tabBtn, addTabBtn);

      // Create grid for this tab
      const gridContainer = document.querySelector('.grid-container');
      const newGrid = createGridForTab(tabId);
      gridContainer.appendChild(newGrid);

      // Attach event listeners
      attachTabButtonListeners(tabBtn);

      // Switch to new tab
      switchTab(tabId);
    }
```

**Step 3: Add createGridForTab function**

```javascript
    function createGridForTab(tabId) {
      const grid = document.createElement('div');
      grid.className = 'grid terminals-1';
      grid.dataset.tabId = tabId;
      grid.style.display = 'none';

      for (let i = 0; i < 4; i++) {
        const container = document.createElement('div');
        container.className = i === 0 ? 'terminal-container' : 'terminal-container hidden-slot';
        container.id = \`term-container-\${tabId}-\${i}\`;
        container.innerHTML = \`
          <div class="terminal-header">
            <span class="terminal-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span>
            <span class="terminal-title empty" id="terminal-title-\${tabId}-\${i}">Terminal \${i + 1}</span>
            <div class="header-actions">
              <button class="action-btn pick-files-btn" id="pick-files-\${tabId}-\${i}" title="Insert file path">
                <svg viewBox="0 0 16 16"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.76.56 2.311 1.184C7.985 3.648 8.48 4 9 4h4.5A1.5 1.5 0 0 1 15 5.5v.64c.57.265.94.876.856 1.546l-.64 5.124A2.5 2.5 0 0 1 12.733 15H3.266a2.5 2.5 0 0 1-2.481-2.19l-.64-5.124A1.5 1.5 0 0 1 1 6.14V3.5zM2 6h12v-.5a.5.5 0 0 0-.5-.5H9c-.964 0-1.71-.629-2.174-1.154C6.374 3.334 5.82 3 5.264 3H2.5a.5.5 0 0 0-.5.5V6z"/></svg>
              </button>
              <button class="action-btn fullscreen-btn" id="fullscreen-\${tabId}-\${i}" title="Toggle fullscreen">
                <svg class="expand-icon" viewBox="0 0 16 16"><path d="M3 3v4h1V4h3V3H3zm10 0h-4v1h3v3h1V3zM4 12v-3H3v4h4v-1H4zm8-3v3h-3v1h4V9h-1z"/></svg>
                <svg class="collapse-icon" style="display:none" viewBox="0 0 16 16"><path d="M2 2h5v5H2V2zm1 1v3h3V3H3zm7-1h5v5h-5V2zm1 1v3h3V3h-3zM2 9h5v5H2V9zm1 1v3h3v-3H3zm7-1h5v5h-5V9zm1 1v3h3v-3h-3z"/></svg>
              </button>
              <button class="action-btn kill-btn" id="kill-\${tabId}-\${i}" title="Kill terminal">
                <svg viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4L4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
              </button>
            </div>
            <span class="status-indicator" id="status-\${tabId}-\${i}"></span>
          </div>
          <div class="terminal-wrapper">
            <div id="terminal-\${tabId}-\${i}">
              <div class="terminal-placeholder">
                <span class="terminal-placeholder-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span>
                <span class="terminal-placeholder-text">Select a project and click "Add Terminal"</span>
              </div>
            </div>
          </div>
        \`;
        grid.appendChild(container);
        attachTerminalContainerListeners(tabId, i, container);
      }

      return grid;
    }
```

**Step 4: Add switchTab function**

```javascript
    function switchTab(tabId) {
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

      // Update terminal count for this tab
      updateTerminalCount();

      // Refit terminals
      setTimeout(fitAll, 50);

      vscode.postMessage({ command: 'switchTab', tabId });
    }
```

**Step 5: Add closeTab function**

```javascript
    function closeTab(tabId) {
      const tab = tabState[tabId];
      if (!tab) return;

      // Check if has active terminals - let extension handle confirmation
      vscode.postMessage({ command: 'closeTab', tabId });
    }
```

**Step 6: Add attachTabButtonListeners function**

```javascript
    function attachTabButtonListeners(tabBtn) {
      const tabId = parseInt(tabBtn.dataset.tabId);

      tabBtn.addEventListener('click', (e) => {
        if (!e.target.closest('.tab-close')) {
          switchTab(tabId);
        }
      });

      const closeBtn = tabBtn.querySelector('.tab-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeTab(tabId);
        });
      }
    }
```

**Step 7: Update add tab button listener**

```javascript
    document.getElementById('add-tab-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'createTab' });
    });
```

**Step 8: Update add terminal to auto-create tab when full**

In `addTerminal` function, after checking for no available slot:

```javascript
    // No available slot - create new tab
    if (targetTerminalId === -1) {
      vscode.postMessage({ command: 'createTab' });
      return;
    }
```

**Step 9: Add message handlers for tab operations**

In the message switch:

```javascript
        case 'tabCreated':
          createTab(message.tabId);
          nextTabId = message.tabId + 1;
          break;
        case 'tabClosed':
          removeTab(message.tabId);
          if (message.newActiveTabId) {
            switchTab(message.newActiveTabId);
          }
          break;
        case 'tabSwitched':
          switchTab(message.tabId);
          break;
```

**Step 10: Add removeTab function**

```javascript
    function removeTab(tabId) {
      // Remove tab button
      const tabBtn = document.querySelector(\`.tab-button[data-tab-id="\${tabId}"]\`);
      if (tabBtn) tabBtn.remove();

      // Remove grid
      const grid = document.querySelector(\`.grid[data-tab-id="\${tabId}"]\`);
      if (grid) grid.remove();

      // Clean up state
      delete tabState[tabId];
    }
```

**Step 11: Compile to verify**

Run: `npm run compile`
Expected: Successful compilation

**Step 12: Commit**

```bash
git add src/extension.ts
git commit -m "feat(tabs): add tab state management in webview"
```

---

## Task 7: Update All Terminal Functions to Use Tab Context

**Files:**
- Modify: `src/extension.ts` (JavaScript section)

**Step 1: Update all terminal-related functions to use tab state**

Update these functions to work with the current tab:
- `updateTerminalCount()` - use `getActiveTab().visibleTerminalCount`
- `updateGridLayout()` - operate on active tab's grid
- `removeTerminalSlot()` - use tab-specific IDs
- `hasAvailableSlot()` - check active tab
- `startTerminalWithProject()` - use tab-specific IDs and state
- `initializeTerminal()` - use tab-specific container IDs
- `fitAll()` - iterate active tab's terminals
- `toggleFullscreen()` - use tab-specific IDs

**Step 2: Update ID patterns**

Change element IDs from `term-container-0` pattern to `term-container-1-0` (tabId-terminalId).

**Step 3: Update all vscode.postMessage calls to include tabId**

Add `tabId: activeTabId` to all messages.

**Step 4: Update message handlers to handle tabId in output/status/killed**

```javascript
        case 'output':
          const outTab = getTab(message.tabId);
          if (outTab && outTab.terminals[message.terminalId]) {
            const term = outTab.terminals[message.terminalId];
            const isAtBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
            term.write(message.data);
            if (isAtBottom) term.scrollToBottom();
          }
          // Mark tab as having activity if not active
          if (message.tabId !== activeTabId) {
            const tabBtn = document.querySelector(\`.tab-button[data-tab-id="\${message.tabId}"]\`);
            if (tabBtn) tabBtn.classList.add('has-activity');
          }
          break;
```

**Step 5: Clear activity indicator on tab switch**

In `switchTab`, after updating active:
```javascript
      // Clear activity indicator
      const activeBtn = document.querySelector(\`.tab-button[data-tab-id="\${tabId}"]\`);
      if (activeBtn) activeBtn.classList.remove('has-activity');
```

**Step 6: Compile to verify**

Run: `npm run compile`
Expected: Successful compilation

**Step 7: Commit**

```bash
git add src/extension.ts
git commit -m "feat(tabs): update terminal functions for tab context"
```

---

## Task 8: Update Initial Tab Setup and Test

**Files:**
- Modify: `src/extension.ts`

**Step 1: Update initial HTML to use tab-specific IDs**

Change all initial element IDs from `term-container-0` to `term-container-1-0`, etc.

**Step 2: Attach initial tab button listeners**

At the end of the script section, before `vscode.postMessage({ command: 'ready' })`:

```javascript
    // Attach listeners to initial tab button
    const initialTabBtn = document.querySelector('.tab-button[data-tab-id="1"]');
    if (initialTabBtn) {
      attachTabButtonListeners(initialTabBtn);
    }

    // Attach terminal container listeners for initial tab
    for (let i = 0; i < 4; i++) {
      const container = document.getElementById('term-container-1-' + i);
      if (container) {
        attachTerminalContainerListeners(1, i, container);
      }
    }
```

**Step 3: Add attachTerminalContainerListeners function**

This extracts the drag-drop and button listeners into a reusable function.

**Step 4: Compile and test**

Run: `npm run compile`
Expected: Successful compilation

**Step 5: Test in VS Code**

Press F5 to launch extension development host:
- Verify Tab 1 appears
- Click "+" to add new tab
- Switch between tabs
- Add terminals in each tab
- Close tab with terminals (should confirm)
- Verify background activity indicator

**Step 6: Commit**

```bash
git add src/extension.ts
git commit -m "feat(tabs): complete tab implementation and test"
```

---

## Task 9: Final Cleanup and Polish

**Files:**
- Modify: `src/extension.ts`

**Step 1: Remove any unused legacy code**

Remove old flat array references and ensure no orphaned code.

**Step 2: Add keyboard shortcuts**

- Ctrl+T / Cmd+T: New tab
- Ctrl+W / Cmd+W: Close tab (with confirmation if has terminals)
- Ctrl+Tab: Next tab
- Ctrl+Shift+Tab: Previous tab

**Step 3: Compile and verify**

Run: `npm run compile`
Expected: Clean compilation

**Step 4: Final test**

- Test all tab operations
- Test with multiple terminals per tab
- Test closing tabs with running terminals
- Test activity indicators

**Step 5: Commit**

```bash
git add src/extension.ts
git commit -m "feat(tabs): cleanup and add keyboard shortcuts"
```

---

## Summary

Total tasks: 9
Estimated new/modified lines: ~600-800

Key changes:
1. TabState interface wraps per-tab terminal state
2. Provider manages Map<tabId, TabState>
3. Tab bar integrated into control panel
4. Webview mirrors tab structure with per-tab grids
5. All messages include tabId
6. Auto-create tab when current tab is full
7. Confirm before closing tabs with active terminals
