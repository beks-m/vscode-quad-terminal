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

  /**
   * Start a terminal with a project
   */
  startTerminal(
    tabId: number,
    terminalId: number,
    projectPath: string,
    sessionId?: string
  ): void {
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
      const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: projectPath,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        } as { [key: string]: string },
      });

      tabState.ptyProcesses.set(terminalId, ptyProcess);
      tabState.terminalProjects.set(terminalId, projectPath);

      // Send PTY output to webview
      ptyProcess.onData((data: string) => {
        this.messenger.sendOutput(tabId, terminalId, data);
        this.markBusy(tabId, terminalId);
      });

      // Handle PTY exit
      ptyProcess.onExit(({ exitCode }) => {
        console.log(
          `[QuadTerminal] Tab ${tabId} Terminal ${terminalId} exited with code ${exitCode}`
        );
        this.cleanupTerminal(tabId, terminalId);
        this.messenger.sendKilled(tabId, terminalId);
      });

      // Auto-run claude after shell init
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
    const tabState = this.tabManager.getTabState(tabId);
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
