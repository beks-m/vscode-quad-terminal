import * as vscode from 'vscode';
import * as os from 'os';
import * as pty from 'node-pty';
import * as path from 'path';

// Constants
const TERMINAL_COUNT = 4;
const SHELL_INIT_DELAY_MS = 500;
const IDLE_TIMEOUT_MS = 2000;
const VALID_TERMINAL_IDS = new Set([0, 1, 2, 3]);

// Store provider reference for cleanup on deactivate
let providerInstance: QuadTerminalViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('Quad Terminal is now active!');

  const provider = new QuadTerminalViewProvider(context.extensionUri);
  providerInstance = provider;

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

  public dispose() {
    this.disposeAllResources();
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

    /* App Container */
    .app-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
    }

    /* Control Panel */
    .control-panel {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      padding: 6px 10px;
      background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      border-bottom: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border, #333));
      flex-shrink: 0;
    }
    .control-panel-section {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 120px;
    }
    .control-panel-divider {
      display: none;
    }
    .control-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      white-space: nowrap;
      display: none;
    }
    .project-select {
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 5px 8px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      min-width: 0;
      flex: 1;
      transition: all 0.15s ease;
    }
    .project-select:hover {
      border-color: var(--vscode-focusBorder, #007acc);
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
    .resume-label {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--vscode-foreground, #ccc);
      cursor: pointer;
      user-select: none;
      padding: 4px 6px;
      border-radius: 4px;
      transition: all 0.12s ease;
      white-space: nowrap;
    }
    .resume-label:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.4));
    }
    .resume-label span {
      display: none;
    }
    .resume-checkbox {
      width: 14px;
      height: 14px;
      cursor: pointer;
      accent-color: var(--vscode-focusBorder, #007acc);
      margin: 0;
    }
    .add-terminal-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0;
      padding: 4px 6px;
      border-radius: 4px;
      border: none;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.15s ease;
      flex-shrink: 0;
    }
    .add-terminal-btn:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }
    .add-terminal-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .add-terminal-btn svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }
    .add-terminal-btn span {
      display: none;
    }
    .terminal-count {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      flex-shrink: 0;
    }

    /* Wider panel - show labels */
    @media (min-width: 350px) {
      .control-panel {
        gap: 10px;
      }
      .resume-label span {
        display: inline;
      }
    }
    @media (min-width: 450px) {
      .add-terminal-btn {
        gap: 6px;
        padding: 4px 10px;
      }
      .add-terminal-btn span {
        display: inline;
      }
    }

    /* Grid Container */
    .grid-container {
      flex: 1;
      min-height: 0;
      height: 0;
      position: relative;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      grid-template-rows: 1fr 1fr;
      height: 100%;
      width: 100%;
      gap: 1px;
      background: var(--vscode-editorGroup-border, var(--vscode-panel-border, #333));
      position: relative;
    }
    .grid.terminals-1 {
      grid-template-columns: 1fr;
      grid-template-rows: 1fr;
    }
    .grid.terminals-2 {
      grid-template-columns: 1fr;
      grid-template-rows: 1fr 1fr;
    }
    .terminal-container.hidden-slot {
      display: none;
    }
    .terminal-container {
      position: relative;
      overflow: hidden;
      background: var(--vscode-editor-background, #1e1e1e);
      transition: all 0.15s ease;
      min-height: 0;
      height: 100%;
    }
    .terminal-container:focus-within {
      z-index: 1;
    }

    /* Terminal Header */
    .terminal-header {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 32px;
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
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.7;
      flex-shrink: 0;
    }
    .terminal-container:focus-within .terminal-icon {
      opacity: 1;
    }
    .terminal-icon svg {
      width: 14px;
      height: 14px;
      fill: currentColor;
    }
    .terminal-title {
      flex: 1;
      font-size: 12px;
      font-weight: 500;
      color: inherit;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .terminal-title.empty {
      font-style: italic;
      opacity: 0.6;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground, #888);
      cursor: pointer;
      border-radius: 4px;
      padding: 0;
      transition: all 0.12s ease;
      opacity: 0;
    }
    .terminal-header:hover .action-btn,
    .terminal-container:focus-within .action-btn {
      opacity: 1;
    }
    .action-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.4));
      color: var(--vscode-foreground, #ccc);
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

    /* Terminal Content */
    .terminal-wrapper {
      position: absolute;
      top: 32px;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--vscode-editor-background, #1e1e1e);
    }
    .terminal-wrapper > div {
      height: 100%;
      width: 100%;
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
      max-width: 180px;
    }
    .xterm {
      height: 100%;
      width: 100%;
      padding: 4px 8px 0 8px;
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

    /* Fullscreen Mode */
    .grid.has-fullscreen .terminal-container {
      display: none;
    }
    .grid.has-fullscreen .terminal-container.fullscreen {
      display: block;
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 10;
    }
  </style>
</head>
<body>
  <div class="app-container">
    <!-- Control Panel -->
    <div class="control-panel">
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

    <!-- Grid Container -->
    <div class="grid-container">
      <div class="grid terminals-1">
        <div class="terminal-container" id="term-container-0">
          <div class="terminal-header">
            <span class="terminal-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span>
            <span class="terminal-title empty" id="terminal-title-0">Terminal 1</span>
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
                <span class="terminal-placeholder-text">Select a project and click "Add Terminal"</span>
              </div>
            </div>
          </div>
        </div>
        <div class="terminal-container hidden-slot" id="term-container-1">
          <div class="terminal-header">
            <span class="terminal-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span>
            <span class="terminal-title empty" id="terminal-title-1">Terminal 2</span>
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
                <span class="terminal-placeholder-text">Select a project and click "Add Terminal"</span>
              </div>
            </div>
          </div>
        </div>
        <div class="terminal-container hidden-slot" id="term-container-2">
          <div class="terminal-header">
            <span class="terminal-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span>
            <span class="terminal-title empty" id="terminal-title-2">Terminal 3</span>
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
                <span class="terminal-placeholder-text">Select a project and click "Add Terminal"</span>
              </div>
            </div>
          </div>
        </div>
        <div class="terminal-container hidden-slot" id="term-container-3">
          <div class="terminal-header">
            <span class="terminal-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span>
            <span class="terminal-title empty" id="terminal-title-3">Terminal 4</span>
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
                <span class="terminal-placeholder-text">Select a project and click "Add Terminal"</span>
              </div>
            </div>
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

    // Track which terminals have active sessions
    const terminalProjects = ['', '', '', ''];

    // Setup kill and fullscreen buttons for each terminal
    for (let i = 0; i < 4; i++) {
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

      // Drag and drop support for files
      const termContainer = document.getElementById('term-container-' + i);
      termContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
      });

      termContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();

        let paths = [];

        // Try to get URI list (for files dragged from VS Code explorer or Finder)
        const uriList = e.dataTransfer.getData('text/uri-list');
        if (uriList) {
          paths = uriList.split(/\\r?\\n/)
            .map(uri => uri.trim())
            .filter(uri => uri && !uri.startsWith('#'))
            .map(uri => {
              if (uri.startsWith('file://')) {
                // Handle file:// URIs - decode and extract path
                let path = decodeURIComponent(uri.slice(7));
                // On Windows, file URIs are like file:///C:/path
                // On Mac/Linux, they're like file:///path
                if (path.length > 2 && path[0] === '/' && path[2] === ':') {
                  // Windows path like /C:/... - remove leading slash
                  path = path.slice(1);
                }
                return path;
              }
              return uri;
            });
        }

        // Also try plain text (some apps provide paths this way)
        if (paths.length === 0) {
          const text = e.dataTransfer.getData('text/plain');
          if (text && (text.startsWith('/') || /^[A-Za-z]:[\\\\\\/]/.test(text))) {
            paths = [text.trim()];
          }
        }

        if (paths.length > 0 && terminalInitialized[i]) {
          // Quote paths with spaces
          const quotedPaths = paths.map(p => p.includes(' ') ? '"' + p + '"' : p);
          vscode.postMessage({
            command: 'input',
            terminalId: i,
            data: quotedPaths.join(' ')
          });
          // Focus the terminal
          if (terminals[i]) {
            terminals[i].focus();
          }
        }
      });
    }

    let currentFullscreen = -1;
    let visibleTerminalCount = 1;

    function updateTerminalCount() {
      document.getElementById('terminal-count').textContent = visibleTerminalCount + ' / 4';
    }

    function updateGridLayout() {
      const grid = document.querySelector('.grid');
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

    function startTerminalWithProject(terminalId, projectPath, projectName, resume) {
      // Initialize the terminal UI
      initializeTerminal(terminalId);

      // Update terminal title
      const titleEl = document.getElementById('terminal-title-' + terminalId);
      titleEl.textContent = projectName;
      titleEl.classList.remove('empty');

      // Store project info
      terminalProjects[terminalId] = projectPath;

      // Update status indicator
      document.getElementById('status-' + terminalId).classList.add('active');

      // Send message to extension to start the terminal
      vscode.postMessage({
        command: 'selectProject',
        terminalId: terminalId,
        projectPath: projectPath,
        resume: resume
      });
    }

    function updateAddButtonState() {
      const globalSelect = document.getElementById('global-project-select');
      const addBtn = document.getElementById('add-terminal-btn');
      const hasProject = globalSelect.value !== '';
      const hasRoom = visibleTerminalCount < 4;
      addBtn.disabled = !hasProject || !hasRoom;
    }

    // Update button state when project selection changes
    document.getElementById('global-project-select').addEventListener('change', updateAddButtonState);

    function addTerminal() {
      const globalSelect = document.getElementById('global-project-select');
      const projectPath = globalSelect.value;
      const projectName = globalSelect.options[globalSelect.selectedIndex]?.text || '';
      const resume = document.getElementById('global-resume').checked;

      // Require a project to be selected
      if (!projectPath) {
        return;
      }

      // Find the first empty terminal slot or add a new one
      let targetTerminalId = -1;

      // First, check if there's an empty visible terminal
      for (let i = 0; i < visibleTerminalCount; i++) {
        if (!terminalProjects[i]) {
          targetTerminalId = i;
          break;
        }
      }

      // If no empty slot, add a new terminal if possible
      if (targetTerminalId === -1) {
        if (visibleTerminalCount >= 4) return;

        targetTerminalId = visibleTerminalCount;
        const container = document.getElementById('term-container-' + targetTerminalId);
        container.classList.remove('hidden-slot');
        visibleTerminalCount++;
        updateGridLayout();
      }

      // Delay terminal start to allow layout to settle
      const tid = targetTerminalId;
      setTimeout(() => {
        startTerminalWithProject(tid, projectPath, projectName, resume);
      }, 100);
    }

    // Add terminal button event listener
    document.getElementById('add-terminal-btn').addEventListener('click', addTerminal);

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

      // Fit after initialization - multiple attempts to handle layout timing
      const doFit = () => {
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
      };

      // Initial fit after short delay
      setTimeout(() => {
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
            terminals[message.terminalId].scrollToBottom();
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
          // Reset terminal title
          const killedTitle = document.getElementById('terminal-title-' + message.terminalId);
          killedTitle.textContent = 'Terminal ' + (message.terminalId + 1);
          killedTitle.classList.add('empty');
          // Clear project tracking
          terminalProjects[message.terminalId] = '';
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
            terminalProjects[i] = '';
            document.getElementById('terminal-' + i).innerHTML = '<div class="terminal-placeholder"><span class="terminal-placeholder-icon"><svg viewBox="0 0 16 16"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/><path d="M2 5l4 3-4 3V5zm5 3h7v1H7V8z"/></svg></span><span class="terminal-placeholder-text">Select a project and click "Add Terminal"</span></div>';
            // Reset terminal title
            const titleEl = document.getElementById('terminal-title-' + i);
            titleEl.textContent = 'Terminal ' + (i + 1);
            titleEl.classList.add('empty');
            document.getElementById('status-' + i).classList.remove('active', 'busy');
            // Hide terminals 1-3
            if (i > 0) {
              document.getElementById('term-container-' + i).classList.add('hidden-slot');
            }
          }
          // Reset global controls
          document.getElementById('global-project-select').value = '';
          document.getElementById('global-resume').checked = false;
          // Reset to single terminal layout
          visibleTerminalCount = 1;
          updateGridLayout();
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

    // Tell extension we're ready
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
}

export function deactivate() {
  // Kill all terminal processes when extension deactivates
  if (providerInstance) {
    providerInstance.dispose();
    providerInstance = undefined;
  }
}
