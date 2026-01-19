import * as vscode from 'vscode';
import {
  ExtensionToWebviewMessage,
  Project,
  TerminalConfig,
  TerminalStatus,
} from '../types';

/**
 * Type-safe wrapper for sending messages from extension to webview
 */
export class WebviewMessenger {
  constructor(private getView: () => vscode.WebviewView | undefined) {}

  private send(message: ExtensionToWebviewMessage): void {
    const view = this.getView();
    if (view) {
      view.webview.postMessage(message);
    }
  }

  /** Send project list to webview */
  sendProjects(projects: Project[]): void {
    this.send({ command: 'projects', projects });
  }

  /** Send terminal configuration to webview */
  sendTerminalConfig(config: TerminalConfig): void {
    this.send({ command: 'terminalConfig', config });
  }

  /** Send terminal output to webview */
  sendOutput(tabId: number, terminalId: number, data: string): void {
    this.send({ command: 'output', tabId, terminalId, data });
  }

  /** Send clear command to webview */
  sendClear(tabId: number, terminalId: number): void {
    this.send({ command: 'clear', tabId, terminalId });
  }

  /** Send error message to webview */
  sendError(tabId: number, terminalId: number, message: string): void {
    this.send({ command: 'error', tabId, terminalId, message });
  }

  /** Send terminal killed notification to webview */
  sendKilled(tabId: number, terminalId: number): void {
    this.send({ command: 'killed', tabId, terminalId });
  }

  /** Send terminal status update to webview */
  sendStatus(tabId: number, terminalId: number, status: TerminalStatus): void {
    this.send({ command: 'status', tabId, terminalId, status });
  }

  /** Send resolved drop paths to webview */
  sendDropResolved(tabId: number, terminalId: number, paths: string): void {
    this.send({ command: 'dropResolved', tabId, terminalId, paths });
  }

  /** Send refresh command to webview */
  sendRefresh(): void {
    this.send({ command: 'refresh' });
  }

  /** Send tab created notification to webview */
  sendTabCreated(tabId: number): void {
    this.send({ command: 'tabCreated', tabId });
  }

  /** Send tab closed notification to webview */
  sendTabClosed(tabId: number, newActiveTabId: number): void {
    this.send({ command: 'tabClosed', tabId, newActiveTabId });
  }

  /** Send tab switched notification to webview */
  sendTabSwitched(tabId: number): void {
    this.send({ command: 'tabSwitched', tabId });
  }

  /** Send restarting notification to webview (clears terminal but keeps slot) */
  sendRestarting(tabId: number, terminalId: number): void {
    this.send({ command: 'restarting', tabId, terminalId });
  }
}
