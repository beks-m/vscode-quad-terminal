import * as vscode from 'vscode';
import * as os from 'os';
import * as pty from 'node-pty';
import * as path from 'path';

// Constants
const TERMINAL_COUNT = 4;
const SHELL_INIT_DELAY_MS = 500;
const IDLE_TIMEOUT_MS = 2000;
const VALID_TERMINAL_IDS = new Set([0, 1, 2, 3]);

export function activate(context: vscode.ExtensionContext) {
  console.log('Quad Terminal is now active!');

  const provider = new QuadTerminalViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('quadTerminal.grid', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('quadTerminal.open', () => {
      vscode.commands.executeCommand('quadTerminal.grid.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('quadTerminal.refresh', () => {
      provider.refresh();
    })
  );
}

class QuadTerminalViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private ptyProcesses: Map<number, pty.IPty> = new Map();
  private terminalProjects: Map<number, string> = new Map();
  private idleTimers: Map<number, NodeJS.Timeout> = new Map();
  private terminalBusy: Map<number, boolean> = new Map();
  private claudeCommandTimeouts: Map<number, NodeJS.Timeout> = new Map();

  constructor(private readonly _extensionUri: vscode.Uri) {}

  private isValidTerminalId(terminalId: number): boolean {
    return VALID_TERMINAL_IDS.has(terminalId);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case 'ready':
          this.sendProjectsToWebview();
          this.sendTerminalConfig();
          break;
        case 'selectProject':
          if (this.isValidTerminalId(message.terminalId)) {
            this.startTerminalWithProject(message.terminalId, message.projectPath, message.resume);
          }
          break;
        case 'input':
          if (this.isValidTerminalId(message.terminalId)) {
            this.handleInput(message.terminalId, message.data);
          }
          break;
        case 'resize':
          if (this.isValidTerminalId(message.terminalId)) {
            this.handleResize(message.terminalId, message.cols, message.rows);
          }
          break;
        case 'kill':
          if (this.isValidTerminalId(message.terminalId)) {
            this.killTerminal(message.terminalId);
          }
          break;
      }
    });

    // Update projects when workspace folders change
    const workspaceFolderListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.sendProjectsToWebview();
    });

    // Clean up all resources when view is disposed
    webviewView.onDidDispose(() => {
      workspaceFolderListener.dispose();
      this.disposeAllResources();
    });
  }

  private sendProjectsToWebview() {
    const projects = this.getWorkspaceProjects();
    this.sendToWebview('projects', { projects });
  }

  private sendTerminalConfig() {
    const config = vscode.workspace.getConfiguration('terminal.integrated');
    const editorConfig = vscode.workspace.getConfiguration('editor');

    // Get terminal colors from workbench color customizations
    const workbenchConfig = vscode.workspace.getConfiguration('workbench');
    const colorCustomizations = workbenchConfig.get<Record<string, string>>('colorCustomizations') || {};

    // Try to get current color theme type for better defaults
    const colorTheme = workbenchConfig.get<string>('colorTheme') || '';
    const isDark = !colorTheme.toLowerCase().includes('light');

    // Default colors based on VS Code dark/light theme
    const defaultBg = isDark ? '#1e1e1e' : '#ffffff';
    const defaultFg = isDark ? '#cccccc' : '#333333';

    const terminalConfig = {
      fontFamily: config.get<string>('fontFamily') || editorConfig.get<string>('fontFamily') || 'Menlo, Monaco, monospace',
      fontSize: config.get<number>('fontSize') || 12,
      lineHeight: config.get<number>('lineHeight') || 1.2,
      cursorStyle: config.get<string>('cursorStyle') || 'block',
      cursorBlink: config.get<boolean>('cursorBlinking') !== false,
      colors: {
        background: colorCustomizations['terminal.background'] || colorCustomizations['editor.background'] || '',
        foreground: colorCustomizations['terminal.foreground'] || colorCustomizations['editor.foreground'] || '',
        cursor: colorCustomizations['terminalCursor.foreground'] || '',
        cursorAccent: colorCustomizations['terminalCursor.background'] || '',
        selectionBackground: colorCustomizations['terminal.selectionBackground'] || '',
        black: colorCustomizations['terminal.ansiBlack'] || '',
        red: colorCustomizations['terminal.ansiRed'] || '',
        green: colorCustomizations['terminal.ansiGreen'] || '',
        yellow: colorCustomizations['terminal.ansiYellow'] || '',
        blue: colorCustomizations['terminal.ansiBlue'] || '',
        magenta: colorCustomizations['terminal.ansiMagenta'] || '',
        cyan: colorCustomizations['terminal.ansiCyan'] || '',
        white: colorCustomizations['terminal.ansiWhite'] || '',
        brightBlack: colorCustomizations['terminal.ansiBrightBlack'] || '',
        brightRed: colorCustomizations['terminal.ansiBrightRed'] || '',
        brightGreen: colorCustomizations['terminal.ansiBrightGreen'] || '',
        brightYellow: colorCustomizations['terminal.ansiBrightYellow'] || '',
        brightBlue: colorCustomizations['terminal.ansiBrightBlue'] || '',
        brightMagenta: colorCustomizations['terminal.ansiBrightMagenta'] || '',
        brightCyan: colorCustomizations['terminal.ansiBrightCyan'] || '',
        brightWhite: colorCustomizations['terminal.ansiBrightWhite'] || ''
      },
      isDark
    };

    this.sendToWebview('terminalConfig', { config: terminalConfig });
  }

  private getWorkspaceProjects(): { name: string; path: string }[] {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.map(folder => ({
      name: folder.name,
      path: folder.uri.fsPath
    }));
  }

  private startTerminalWithProject(terminalId: number, projectPath: string, resume: boolean = false) {
    // Clean up existing resources for this terminal
    this.cleanupTerminal(terminalId);

    // Clear the terminal in webview
    this.sendToWebview('clear', { terminalId });

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

      this.ptyProcesses.set(terminalId, ptyProcess);
      this.terminalProjects.set(terminalId, projectPath);

      // Send PTY output to webview
      ptyProcess.onData((data: string) => {
        this.sendToWebview('output', { terminalId, data });
        this.markBusy(terminalId);
      });

      // Handle PTY exit (natural termination like typing 'exit')
      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`[QuadTerminal] Terminal ${terminalId} exited with code ${exitCode}`);
        this.cleanupTerminal(terminalId);
        this.sendToWebview('killed', { terminalId });
      });

      // Auto-run claude after a short delay for shell to initialize
      const timeout = setTimeout(() => {
        // Verify PTY still exists before writing
        if (this.ptyProcesses.has(terminalId)) {
          const claudeCmd = resume ? 'claude --dangerously-skip-permissions --resume\r' : 'claude --dangerously-skip-permissions\r';
          ptyProcess.write(claudeCmd);
        }
        this.claudeCommandTimeouts.delete(terminalId);
      }, SHELL_INIT_DELAY_MS);
      this.claudeCommandTimeouts.set(terminalId, timeout);

    } catch (error) {
      console.error(`[QuadTerminal] Failed to create PTY process ${terminalId}:`, error);
      this.sendToWebview('error', {
        terminalId,
        message: `Failed to start terminal: ${error}`
      });
    }
  }

  private cleanupTerminal(terminalId: number) {
    // Kill existing PTY
    const existingPty = this.ptyProcesses.get(terminalId);
    if (existingPty) {
      existingPty.kill();
      this.ptyProcesses.delete(terminalId);
    }

    // Clear idle timer
    this.clearIdleTimer(terminalId);

    // Clear claude command timeout
    const cmdTimeout = this.claudeCommandTimeouts.get(terminalId);
    if (cmdTimeout) {
      clearTimeout(cmdTimeout);
      this.claudeCommandTimeouts.delete(terminalId);
    }

    // Clear other state
    this.terminalBusy.delete(terminalId);
    this.terminalProjects.delete(terminalId);
  }

  private handleInput(terminalId: number, data: string) {
    const ptyProcess = this.ptyProcesses.get(terminalId);
    if (ptyProcess) {
      ptyProcess.write(data);
    }
  }

  private handleResize(terminalId: number, cols: number, rows: number) {
    const ptyProcess = this.ptyProcesses.get(terminalId);
    if (ptyProcess && cols > 0 && rows > 0) {
      try {
        ptyProcess.resize(cols, rows);
      } catch (e) {
        // Ignore resize errors
      }
    }
  }

  private killTerminal(terminalId: number) {
    const ptyProcess = this.ptyProcesses.get(terminalId);
    if (ptyProcess) {
      this.cleanupTerminal(terminalId);
      this.sendToWebview('killed', { terminalId });
    }
  }

  private markBusy(terminalId: number) {
    // Clear existing timer
    this.clearIdleTimer(terminalId);

    // Mark as busy if not already
    if (!this.terminalBusy.get(terminalId)) {
      this.terminalBusy.set(terminalId, true);
      this.sendToWebview('status', { terminalId, status: 'busy' });
    }

    // Set timer to mark as idle after no output
    const timer = setTimeout(() => {
      this.terminalBusy.set(terminalId, false);
      this.sendToWebview('status', { terminalId, status: 'idle' });
    }, IDLE_TIMEOUT_MS);
    this.idleTimers.set(terminalId, timer);
  }

  private clearIdleTimer(terminalId: number) {
    const timer = this.idleTimers.get(terminalId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(terminalId);
    }
  }

  private sendToWebview(command: string, data: any) {
    if (this._view) {
      this._view.webview.postMessage({ command, ...data });
    }
  }

  private disposeAllResources() {
    // Kill all PTY processes
    this.ptyProcesses.forEach((ptyProcess) => {
      ptyProcess.kill();
    });
    this.ptyProcesses.clear();

    // Clear all idle timers
    this.idleTimers.forEach((timer) => {
      clearTimeout(timer);
    });
    this.idleTimers.clear();

    // Clear all claude command timeouts
    this.claudeCommandTimeouts.forEach((timeout) => {
      clearTimeout(timeout);
    });
    this.claudeCommandTimeouts.clear();

    // Clear other state
    this.terminalBusy.clear();
    this.terminalProjects.clear();
  }

  public refresh() {
    this.disposeAllResources();
    if (this._view) {
      this._view.webview.postMessage({ command: 'refresh' });
      this.sendProjectsToWebview();
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net data:;">
  <title>Quad Terminal</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.4.0/css/xterm.min.css">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    html, body {
      height: 100%;
      width: 100%;
      overflow: hidden;
      background: var(--vscode-editor-background, #1e1e1e);
      font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      grid-template-rows: 1fr 1fr;
      height: 100%;
      width: 100%;
      gap: 1px;
      background: var(--vscode-editorGroup-border, var(--vscode-panel-border, #333));
    }
    .terminal-container {
      position: relative;
      overflow: hidden;
      background: var(--vscode-editor-background, #1e1e1e);
      transition: all 0.15s ease;
    }
    .terminal-container:focus-within {
      z-index: 1;
    }
    .terminal-header {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 36px;
      background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      color: var(--vscode-tab-inactiveForeground, #969696);
      font-size: 12px;
      padding: 0 10px;
      z-index: 10;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border, #333));
      transition: all 0.15s ease;
    }
    .terminal-container:focus-within .terminal-header {
      background: var(--vscode-tab-activeBackground, #1e1e1e);
      color: var(--vscode-tab-activeForeground, #fff);
      border-bottom-color: var(--vscode-focusBorder, #007acc);
    }
    .terminal-icon {
      width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.7;
      transition: opacity 0.15s ease;
    }
    .terminal-container:focus-within .terminal-icon {
      opacity: 1;
    }
    .terminal-icon svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }
    .project-select {
      flex: 1;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      min-width: 0;
      transition: all 0.15s ease;
    }
    .project-select.hidden {
      display: none;
    }
    .project-select:hover {
      border-color: var(--vscode-input-border, #555);
    }
    .project-select:focus {
      outline: none;
      border-color: var(--vscode-focusBorder, #007acc);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007acc);
    }
    .project-select option {
      background: var(--vscode-dropdown-background, #252526);
      color: var(--vscode-dropdown-foreground, #ccc);
      padding: 4px;
    }
    .project-name {
      flex: 1;
      font-size: 12px;
      font-weight: 500;
      color: var(--vscode-foreground, #ccc);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      display: none;
    }
    .project-name.visible {
      display: block;
    }
    .header-divider {
      width: 1px;
      height: 16px;
      background: var(--vscode-editorGroup-border, #444);
      opacity: 0.5;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .terminal-wrapper {
      position: absolute;
      top: 36px;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--vscode-editor-background, #1e1e1e);
    }
    .terminal-placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--vscode-descriptionForeground, #888);
      font-size: 13px;
      gap: 12px;
      opacity: 0.8;
      padding: 20px;
      text-align: center;
    }
    .terminal-placeholder-icon {
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 12px;
      background: var(--vscode-input-background, #3c3c3c);
      opacity: 0.6;
    }
    .terminal-placeholder-icon svg {
      width: 24px;
      height: 24px;
      fill: currentColor;
    }
    .terminal-placeholder-text {
      font-size: 12px;
      line-height: 1.5;
      max-width: 160px;
    }
    .xterm {
      height: 100%;
      width: 100%;
      padding: 8px 12px;
    }
    .xterm-viewport {
      overflow-y: auto !important;
    }
    .xterm-viewport::-webkit-scrollbar {
      width: 8px;
    }
    .xterm-viewport::-webkit-scrollbar-track {
      background: transparent;
    }
    .xterm-viewport::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
      border-radius: 4px;
    }
    .xterm-viewport::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.7));
    }
    .xterm .xterm-screen {
      cursor: text;
    }
    .status-indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-descriptionForeground, #555);
      flex-shrink: 0;
      transition: all 0.2s ease;
    }
    .status-indicator.active {
      background: var(--vscode-terminal-ansiGreen, #89d185);
      box-shadow: 0 0 6px var(--vscode-terminal-ansiGreen, #89d185);
    }
    .status-indicator.busy {
      background: var(--vscode-terminal-ansiYellow, #e5e510);
      box-shadow: 0 0 6px var(--vscode-terminal-ansiYellow, #e5e510);
      animation: pulse 1.2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.6; transform: scale(0.9); }
    }
    .action-btn {
      display: none;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground, #888);
      cursor: pointer;
      border-radius: 4px;
      padding: 0;
      transition: all 0.12s ease;
    }
    .action-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.4));
      color: var(--vscode-foreground, #ccc);
    }
    .action-btn.visible {
      display: flex;
    }
    .action-btn svg {
      width: 14px;
      height: 14px;
      fill: currentColor;
    }
    .action-btn.kill-btn:hover {
      color: var(--vscode-errorForeground, #f48771);
      background: rgba(244, 135, 113, 0.1);
    }
    .grid.has-fullscreen .terminal-container {
      display: none;
    }
    .grid.has-fullscreen .terminal-container.fullscreen {
      display: block;
      grid-column: 1 / -1;
      grid-row: 1 / -1;
    }
    .resume-label {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      cursor: pointer;
      user-select: none;
      padding: 4px 6px;
      border-radius: 4px;
      transition: all 0.12s ease;
    }
    .resume-label.hidden {
      display: none;
    }
    .resume-label:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.4));
      color: var(--vscode-foreground, #ccc);
    }
    .resume-checkbox {
      width: 13px;
      height: 13px;
      cursor: pointer;
      accent-color: var(--vscode-focusBorder, #007acc);
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="grid">
    <div class="terminal-container" id="term-container-0">
      <div class="terminal-header">
        <span class="terminal-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span>
        <select class="project-select" id="project-select-0">
          <option value="">Select project...</option>
        </select>
        <span class="project-name" id="project-name-0"></span>
        <label class="resume-label" id="resume-label-0" title="Resume previous Claude session">
          <input type="checkbox" class="resume-checkbox" id="resume-0">
          <span>resume</span>
        </label>
        <span class="header-divider"></span>
        <div class="header-actions">
          <button class="action-btn fullscreen-btn" id="fullscreen-0" title="Toggle fullscreen">
            <svg class="expand-icon" viewBox="0 0 16 16"><path d="M3 3v4h1V4h3V3H3zm10 0h-4v1h3v3h1V3zM4 12v-3H3v4h4v-1H4zm8-3v3h-3v1h4V9h-1z"/></svg>
            <svg class="collapse-icon" style="display:none" viewBox="0 0 16 16"><path d="M2 2h5v5H2V2zm1 1v3h3V3H3zm7-1h5v5h-5V2zm1 1v3h3V3h-3zM2 9h5v5H2V9zm1 1v3h3v-3H3zm7-1h5v5h-5V9zm1 1v3h3v-3h-3z"/></svg>
          </button>
          <button class="action-btn kill-btn" id="kill-0" title="Kill terminal">
            <svg viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4L4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
          </button>
        </div>
        <span class="status-indicator" id="status-0"></span>
      </div>
      <div class="terminal-wrapper">
        <div id="terminal-0">
          <div class="terminal-placeholder">
            <span class="terminal-placeholder-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span>
            <span class="terminal-placeholder-text">Select a project to start Claude</span>
          </div>
        </div>
      </div>
    </div>
    <div class="terminal-container" id="term-container-1">
      <div class="terminal-header">
        <span class="terminal-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span>
        <select class="project-select" id="project-select-1">
          <option value="">Select project...</option>
        </select>
        <span class="project-name" id="project-name-1"></span>
        <label class="resume-label" id="resume-label-1" title="Resume previous Claude session">
          <input type="checkbox" class="resume-checkbox" id="resume-1">
          <span>resume</span>
        </label>
        <span class="header-divider"></span>
        <div class="header-actions">
          <button class="action-btn fullscreen-btn" id="fullscreen-1" title="Toggle fullscreen">
            <svg class="expand-icon" viewBox="0 0 16 16"><path d="M3 3v4h1V4h3V3H3zm10 0h-4v1h3v3h1V3zM4 12v-3H3v4h4v-1H4zm8-3v3h-3v1h4V9h-1z"/></svg>
            <svg class="collapse-icon" style="display:none" viewBox="0 0 16 16"><path d="M2 2h5v5H2V2zm1 1v3h3V3H3zm7-1h5v5h-5V2zm1 1v3h3V3h-3zM2 9h5v5H2V9zm1 1v3h3v-3H3zm7-1h5v5h-5V9zm1 1v3h3v-3h-3z"/></svg>
          </button>
          <button class="action-btn kill-btn" id="kill-1" title="Kill terminal">
            <svg viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4L4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
          </button>
        </div>
        <span class="status-indicator" id="status-1"></span>
      </div>
      <div class="terminal-wrapper">
        <div id="terminal-1">
          <div class="terminal-placeholder">
            <span class="terminal-placeholder-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span>
            <span class="terminal-placeholder-text">Select a project to start Claude</span>
          </div>
        </div>
      </div>
    </div>
    <div class="terminal-container" id="term-container-2">
      <div class="terminal-header">
        <span class="terminal-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span>
        <select class="project-select" id="project-select-2">
          <option value="">Select project...</option>
        </select>
        <span class="project-name" id="project-name-2"></span>
        <label class="resume-label" id="resume-label-2" title="Resume previous Claude session">
          <input type="checkbox" class="resume-checkbox" id="resume-2">
          <span>resume</span>
        </label>
        <span class="header-divider"></span>
        <div class="header-actions">
          <button class="action-btn fullscreen-btn" id="fullscreen-2" title="Toggle fullscreen">
            <svg class="expand-icon" viewBox="0 0 16 16"><path d="M3 3v4h1V4h3V3H3zm10 0h-4v1h3v3h1V3zM4 12v-3H3v4h4v-1H4zm8-3v3h-3v1h4V9h-1z"/></svg>
            <svg class="collapse-icon" style="display:none" viewBox="0 0 16 16"><path d="M2 2h5v5H2V2zm1 1v3h3V3H3zm7-1h5v5h-5V2zm1 1v3h3V3h-3zM2 9h5v5H2V9zm1 1v3h3v-3H3zm7-1h5v5h-5V9zm1 1v3h3v-3h-3z"/></svg>
          </button>
          <button class="action-btn kill-btn" id="kill-2" title="Kill terminal">
            <svg viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4L4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
          </button>
        </div>
        <span class="status-indicator" id="status-2"></span>
      </div>
      <div class="terminal-wrapper">
        <div id="terminal-2">
          <div class="terminal-placeholder">
            <span class="terminal-placeholder-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span>
            <span class="terminal-placeholder-text">Select a project to start Claude</span>
          </div>
        </div>
      </div>
    </div>
    <div class="terminal-container" id="term-container-3">
      <div class="terminal-header">
        <span class="terminal-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span>
        <select class="project-select" id="project-select-3">
          <option value="">Select project...</option>
        </select>
        <span class="project-name" id="project-name-3"></span>
        <label class="resume-label" id="resume-label-3" title="Resume previous Claude session">
          <input type="checkbox" class="resume-checkbox" id="resume-3">
          <span>resume</span>
        </label>
        <span class="header-divider"></span>
        <div class="header-actions">
          <button class="action-btn fullscreen-btn" id="fullscreen-3" title="Toggle fullscreen">
            <svg class="expand-icon" viewBox="0 0 16 16"><path d="M3 3v4h1V4h3V3H3zm10 0h-4v1h3v3h1V3zM4 12v-3H3v4h4v-1H4zm8-3v3h-3v1h4V9h-1z"/></svg>
            <svg class="collapse-icon" style="display:none" viewBox="0 0 16 16"><path d="M2 2h5v5H2V2zm1 1v3h3V3H3zm7-1h5v5h-5V2zm1 1v3h3V3h-3zM2 9h5v5H2V9zm1 1v3h3v-3H3zm7-1h5v5h-5V9zm1 1v3h3v-3h-3z"/></svg>
          </button>
          <button class="action-btn kill-btn" id="kill-3" title="Kill terminal">
            <svg viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4L4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
          </button>
        </div>
        <span class="status-indicator" id="status-3"></span>
      </div>
      <div class="terminal-wrapper">
        <div id="terminal-3">
          <div class="terminal-placeholder">
            <span class="terminal-placeholder-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span>
            <span class="terminal-placeholder-text">Select a project to start Claude</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.4.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.9.0/lib/addon-fit.min.js"></script>
  <script>
    const vscode = acquireVsCodeApi();
    const terminals = [];
    const fitAddons = [];
    const terminalInitialized = [false, false, false, false];

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

    // Setup project selectors and kill buttons
    for (let i = 0; i < 4; i++) {
      const select = document.getElementById('project-select-' + i);
      select.addEventListener('change', (e) => {
        const projectPath = e.target.value;
        if (projectPath) {
          const resumeCheckbox = document.getElementById('resume-' + i);
          const resume = resumeCheckbox.checked;
          initializeTerminal(i);
          vscode.postMessage({
            command: 'selectProject',
            terminalId: i,
            projectPath: projectPath,
            resume: resume
          });
          document.getElementById('status-' + i).classList.add('active');
          document.getElementById('kill-' + i).classList.add('visible');
          document.getElementById('fullscreen-' + i).classList.add('visible');
          // Hide dropdown and resume, show project name
          document.getElementById('project-select-' + i).classList.add('hidden');
          document.getElementById('resume-label-' + i).classList.add('hidden');
          const projectNameEl = document.getElementById('project-name-' + i);
          projectNameEl.textContent = e.target.options[e.target.selectedIndex].text;
          projectNameEl.classList.add('visible');
        }
      });

      const killBtn = document.getElementById('kill-' + i);
      killBtn.addEventListener('click', () => {
        vscode.postMessage({
          command: 'kill',
          terminalId: i
        });
      });

      const fullscreenBtn = document.getElementById('fullscreen-' + i);
      fullscreenBtn.addEventListener('click', () => {
        toggleFullscreen(i);
      });
    }

    let currentFullscreen = -1;

    function toggleFullscreen(terminalId) {
      const grid = document.querySelector('.grid');
      const container = document.getElementById('term-container-' + terminalId);
      const btn = document.getElementById('fullscreen-' + terminalId);
      const expandIcon = btn.querySelector('.expand-icon');
      const collapseIcon = btn.querySelector('.collapse-icon');

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
          const prevContainer = document.getElementById('term-container-' + currentFullscreen);
          const prevBtn = document.getElementById('fullscreen-' + currentFullscreen);
          prevContainer.classList.remove('fullscreen');
          prevBtn.querySelector('.expand-icon').style.display = '';
          prevBtn.querySelector('.collapse-icon').style.display = 'none';
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
      if (terminalInitialized[i]) {
        return; // Already initialized
      }

      const container = document.getElementById('terminal-' + i);
      container.innerHTML = ''; // Clear placeholder

      const term = new Terminal({
        theme,
        fontSize: terminalFontSize,
        fontFamily: terminalFontFamily,
        cursorBlink: true,
        scrollback: 10000,
        allowProposedApi: true,
        disableStdin: false,
        cursorStyle: 'block',
        lineHeight: 1.2
      });

      const fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);

      term.open(container);

      // Focus terminal on click
      container.addEventListener('click', () => {
        term.focus();
      });

      terminals[i] = term;
      fitAddons[i] = fitAddon;
      terminalInitialized[i] = true;

      // Send input to extension
      term.onData((data) => {
        vscode.postMessage({
          command: 'input',
          terminalId: i,
          data: data
        });
      });

      // Send resize to extension
      term.onResize(({ cols, rows }) => {
        vscode.postMessage({
          command: 'resize',
          terminalId: i,
          cols,
          rows
        });
      });

      // Fit after initialization
      setTimeout(() => {
        fitAddon.fit();
        const dims = fitAddon.proposeDimensions();
        if (dims) {
          vscode.postMessage({
            command: 'resize',
            terminalId: i,
            cols: dims.cols,
            rows: dims.rows
          });
        }
        term.focus();
      }, 100);
    }

    // Fit all initialized terminals
    function fitAll() {
      fitAddons.forEach((addon, i) => {
        if (addon && terminalInitialized[i]) {
          try {
            addon.fit();
            const dims = addon.proposeDimensions();
            if (dims) {
              vscode.postMessage({
                command: 'resize',
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
    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.command) {
        case 'projects':
          updateProjectSelectors(message.projects);
          break;
        case 'terminalConfig':
          receivedConfig = message.config;
          applyTerminalConfig(message.config);
          break;
        case 'output':
          if (terminals[message.terminalId]) {
            terminals[message.terminalId].write(message.data);
          }
          break;
        case 'clear':
          if (terminals[message.terminalId]) {
            terminals[message.terminalId].clear();
            terminals[message.terminalId].reset();
          }
          break;
        case 'error':
          if (terminals[message.terminalId]) {
            terminals[message.terminalId].write('\\x1b[31m' + message.message + '\\x1b[0m\\r\\n');
          }
          break;
        case 'killed':
          document.getElementById('status-' + message.terminalId).classList.remove('active', 'busy');
          document.getElementById('kill-' + message.terminalId).classList.remove('visible');
          document.getElementById('fullscreen-' + message.terminalId).classList.remove('visible');
          // Show dropdown and resume, hide project name
          document.getElementById('project-select-' + message.terminalId).classList.remove('hidden');
          document.getElementById('project-select-' + message.terminalId).value = '';
          document.getElementById('resume-label-' + message.terminalId).classList.remove('hidden');
          document.getElementById('project-name-' + message.terminalId).classList.remove('visible');
          if (terminals[message.terminalId]) {
            terminals[message.terminalId].write('\\r\\n\\x1b[90m[Process terminated]\\x1b[0m\\r\\n');
          }
          // Exit fullscreen if this terminal was fullscreened
          if (currentFullscreen === message.terminalId) {
            toggleFullscreen(message.terminalId);
          }
          break;
        case 'status':
          const statusEl = document.getElementById('status-' + message.terminalId);
          if (message.status === 'busy') {
            statusEl.classList.remove('active');
            statusEl.classList.add('busy');
          } else {
            statusEl.classList.remove('busy');
            statusEl.classList.add('active');
          }
          break;
        case 'refresh':
          // Exit fullscreen if active
          if (currentFullscreen >= 0) {
            const grid = document.querySelector('.grid');
            const prevContainer = document.getElementById('term-container-' + currentFullscreen);
            const prevBtn = document.getElementById('fullscreen-' + currentFullscreen);
            grid.classList.remove('has-fullscreen');
            prevContainer.classList.remove('fullscreen');
            prevBtn.querySelector('.expand-icon').style.display = '';
            prevBtn.querySelector('.collapse-icon').style.display = 'none';
            currentFullscreen = -1;
          }
          // Reset all terminals
          for (let i = 0; i < 4; i++) {
            if (terminals[i]) {
              terminals[i].clear();
              terminals[i].reset();
            }
            terminalInitialized[i] = false;
            document.getElementById('terminal-' + i).innerHTML = '<div class="terminal-placeholder"><span class="terminal-placeholder-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span><span class="terminal-placeholder-text">Select a project to start Claude</span></div>';
            document.getElementById('project-select-' + i).value = '';
            document.getElementById('project-select-' + i).classList.remove('hidden');
            document.getElementById('resume-label-' + i).classList.remove('hidden');
            document.getElementById('project-name-' + i).classList.remove('visible');
            document.getElementById('status-' + i).classList.remove('active', 'busy');
            document.getElementById('kill-' + i).classList.remove('visible');
            document.getElementById('fullscreen-' + i).classList.remove('visible');
          }
          break;
      }
    });

    function applyTerminalConfig(config) {
      // Build new theme from received config, using existing fallbacks
      const newTheme = {
        background: config.colors.background || theme.background,
        foreground: config.colors.foreground || theme.foreground,
        cursor: config.colors.cursor || theme.cursor,
        cursorAccent: config.colors.cursorAccent || theme.cursorAccent,
        selectionBackground: config.colors.selectionBackground || theme.selectionBackground,
        black: config.colors.black || theme.black,
        red: config.colors.red || theme.red,
        green: config.colors.green || theme.green,
        yellow: config.colors.yellow || theme.yellow,
        blue: config.colors.blue || theme.blue,
        magenta: config.colors.magenta || theme.magenta,
        cyan: config.colors.cyan || theme.cyan,
        white: config.colors.white || theme.white,
        brightBlack: config.colors.brightBlack || theme.brightBlack,
        brightRed: config.colors.brightRed || theme.brightRed,
        brightGreen: config.colors.brightGreen || theme.brightGreen,
        brightYellow: config.colors.brightYellow || theme.brightYellow,
        brightBlue: config.colors.brightBlue || theme.brightBlue,
        brightMagenta: config.colors.brightMagenta || theme.brightMagenta,
        brightCyan: config.colors.brightCyan || theme.brightCyan,
        brightWhite: config.colors.brightWhite || theme.brightWhite
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
      document.body.style.background = bgColor;

      // Update existing terminals with new theme
      terminals.forEach((term, i) => {
        if (term && terminalInitialized[i]) {
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

    function updateProjectSelectors(projects) {
      for (let i = 0; i < 4; i++) {
        const select = document.getElementById('project-select-' + i);
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
      }
    }

    // Tell extension we're ready
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
}

export function deactivate() {}
