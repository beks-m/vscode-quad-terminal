import * as os from 'os';
import * as pty from 'node-pty';
import { TabState } from '../types';
import { SHELL_INIT_DELAY_MS, IDLE_TIMEOUT_MS } from '../constants';
import { WebviewMessenger } from './webview-messenger';
import { TabManager } from './tab-manager';

/**
 * Manages PTY lifecycle, I/O, and busy/idle status
 */
export class TerminalManager {
  constructor(
    private tabManager: TabManager,
    private messenger: WebviewMessenger
  ) {}

  private timestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Start a terminal with a project
   */
  startTerminal(
    tabId: number,
    terminalId: number,
    projectPath: string,
    sessionId?: string,
    skipClaude?: boolean
  ): void {
    console.log(`[${this.timestamp()}] [QuadTerminal] startTerminal called: tab=${tabId}, terminal=${terminalId}, path=${projectPath}`);

    // Log all existing PTY processes across all tabs
    for (const [tid, ts] of this.tabManager.getAllTabs()) {
      for (const [termId, pty] of ts.ptyProcesses) {
        console.log(`[${this.timestamp()}] [QuadTerminal] Existing PTY: tab=${tid}, terminal=${termId}, pid=${pty.pid}`);
      }
    }

    const tabState = this.tabManager.getTabState(tabId);
    if (!tabState) return;

    // Clean up existing resources for this terminal
    this.cleanupTerminal(tabId, terminalId);

    // Clear the terminal in webview
    this.messenger.sendClear(tabId, terminalId);

    const shell =
      os.platform() === 'win32'
        ? 'powershell.exe'
        : process.env.SHELL || '/bin/zsh';

    try {
      // Create clean environment without Claude Code specific variables
      // that might cause conflicts when running multiple Claude instances
      const cleanEnv = { ...process.env };
      delete cleanEnv.CLAUDECODE;
      delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
      delete cleanEnv.CLAUDE_CODE_SESSION;
      delete cleanEnv.VSCODE_GIT_IPC_HANDLE;

      const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: projectPath,
        env: {
          ...cleanEnv,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        } as { [key: string]: string },
      });

      console.log(`[${this.timestamp()}] [QuadTerminal] Created new PTY: tab=${tabId}, terminal=${terminalId}, pid=${ptyProcess.pid}`);
      tabState.ptyProcesses.set(terminalId, ptyProcess);
      tabState.terminalProjects.set(terminalId, projectPath);

      // Send PTY output to webview
      ptyProcess.onData((data: string) => {
        this.messenger.sendOutput(tabId, terminalId, data);
        this.markBusy(tabId, terminalId);
      });

      // Handle PTY exit
      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(
          `[${this.timestamp()}] [QuadTerminal] PTY EXIT: tab=${tabId}, terminal=${terminalId}, pid=${ptyProcess.pid}, exitCode=${exitCode}, signal=${signal}`
        );
        this.cleanupTerminal(tabId, terminalId);
        this.messenger.sendKilled(tabId, terminalId);
      });

      // Auto-run claude after shell init (unless skipClaude is true)
      if (!skipClaude) {
        const timeout = setTimeout(() => {
          if (tabState.ptyProcesses.has(terminalId)) {
            let claudeCmd: string;
            if (sessionId) {
              claudeCmd = `claude --dangerously-skip-permissions --resume ${sessionId}\r`;
            } else {
              claudeCmd = 'claude --dangerously-skip-permissions\r';
            }
            ptyProcess.write(claudeCmd);
          }
          tabState.claudeCommandTimeouts.delete(terminalId);
        }, SHELL_INIT_DELAY_MS);
        tabState.claudeCommandTimeouts.set(terminalId, timeout);
      }
    } catch (error) {
      console.error(
        `[QuadTerminal] Failed to create PTY process tab ${tabId} terminal ${terminalId}:`,
        error
      );
      this.messenger.sendError(
        tabId,
        terminalId,
        `Failed to start terminal: ${error}`
      );
    }
  }

  /**
   * Clean up terminal resources
   */
  cleanupTerminal(tabId: number, terminalId: number): void {
    console.log(`[${this.timestamp()}] [QuadTerminal] cleanupTerminal called: tab=${tabId}, terminal=${terminalId}`);

    const tabState = this.tabManager.getTabState(tabId);
    if (!tabState) {
      console.log(`[${this.timestamp()}] [QuadTerminal] cleanupTerminal: no tabState for tab=${tabId}`);
      return;
    }

    const existingPty = tabState.ptyProcesses.get(terminalId);
    if (existingPty) {
      console.log(`[${this.timestamp()}] [QuadTerminal] cleanupTerminal: KILLING PTY pid=${existingPty.pid} in tab=${tabId}, terminal=${terminalId}`);
      existingPty.kill();
      tabState.ptyProcesses.delete(terminalId);
    } else {
      console.log(`[${this.timestamp()}] [QuadTerminal] cleanupTerminal: no existing PTY for tab=${tabId}, terminal=${terminalId}`);
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

  /**
   * Handle input from webview to PTY
   */
  handleInput(tabId: number, terminalId: number, data: string): void {
    const tabState = this.tabManager.getTabState(tabId);
    const ptyProcess = tabState?.ptyProcesses.get(terminalId);
    if (ptyProcess) {
      ptyProcess.write(data);
    }
  }

  /**
   * Handle resize from webview
   */
  handleResize(
    tabId: number,
    terminalId: number,
    cols: number,
    rows: number
  ): void {
    const tabState = this.tabManager.getTabState(tabId);
    const ptyProcess = tabState?.ptyProcesses.get(terminalId);
    if (ptyProcess && cols > 0 && rows > 0) {
      try {
        ptyProcess.resize(cols, rows);
      } catch {
        // Ignore resize errors
      }
    }
  }

  /**
   * Kill a terminal
   */
  killTerminal(tabId: number, terminalId: number): void {
    const tabState = this.tabManager.getTabState(tabId);
    const ptyProcess = tabState?.ptyProcesses.get(terminalId);
    if (ptyProcess) {
      this.cleanupTerminal(tabId, terminalId);
      this.messenger.sendKilled(tabId, terminalId);
    }
  }

  /**
   * Restart a terminal with the same project
   */
  restartTerminal(tabId: number, terminalId: number): void {
    const tabState = this.tabManager.getTabState(tabId);
    if (!tabState) return;

    // Get the current project path before killing
    const projectPath = tabState.terminalProjects.get(terminalId);
    if (!projectPath) return; // No project to restart

    // Send restarting message (clears terminal but keeps slot)
    this.messenger.sendRestarting(tabId, terminalId);

    // Kill the terminal process
    this.cleanupTerminal(tabId, terminalId);

    // Restart with the same project after a short delay
    setTimeout(() => {
      this.startTerminal(tabId, terminalId, projectPath);
    }, 100);
  }

  /**
   * Clean up all terminals in a tab
   */
  cleanupAllTerminalsInTab(tabId: number): void {
    const tabState = this.tabManager.getTabState(tabId);
    if (!tabState) return;

    for (const terminalId of tabState.ptyProcesses.keys()) {
      this.cleanupTerminal(tabId, terminalId);
    }
  }

  /**
   * Dispose all resources across all tabs
   */
  disposeAll(): void {
    for (const [tabId, tabState] of this.tabManager.getAllTabs()) {
      for (const ptyProcess of tabState.ptyProcesses.values()) {
        ptyProcess.kill();
      }
      for (const timer of tabState.idleTimers.values()) {
        clearTimeout(timer);
      }
      for (const timeout of tabState.claudeCommandTimeouts.values()) {
        clearTimeout(timeout);
      }
    }
  }

  /**
   * Mark terminal as busy and schedule idle transition
   */
  private markBusy(tabId: number, terminalId: number): void {
    const tabState = this.tabManager.getTabState(tabId);
    if (!tabState) return;

    this.clearIdleTimer(tabId, terminalId);

    if (!tabState.terminalBusy.get(terminalId)) {
      tabState.terminalBusy.set(terminalId, true);
      this.messenger.sendStatus(tabId, terminalId, 'busy');
    }

    const timer = setTimeout(() => {
      // Re-fetch tabState inside closure to handle tab deletion during timeout
      const currentTabState = this.tabManager.getTabState(tabId);
      if (!currentTabState) return;

      currentTabState.terminalBusy.set(terminalId, false);
      this.messenger.sendStatus(tabId, terminalId, 'idle');
      currentTabState.idleTimers.delete(terminalId);
    }, IDLE_TIMEOUT_MS);
    tabState.idleTimers.set(terminalId, timer);
  }

  /**
   * Clear idle timer for a terminal
   */
  private clearIdleTimer(tabId: number, terminalId: number): void {
    const tabState = this.tabManager.getTabState(tabId);
    const timer = tabState?.idleTimers.get(terminalId);
    if (timer) {
      clearTimeout(timer);
      tabState?.idleTimers.delete(terminalId);
    }
  }
}
