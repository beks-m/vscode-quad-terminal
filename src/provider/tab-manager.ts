import * as vscode from 'vscode';
import { TabState } from '../types';
import { WebviewMessenger } from './webview-messenger';

/**
 * Manages tab state (Map<tabId, TabState>), active tab tracking, and tab lifecycle
 */
export class TabManager {
  private tabs: Map<number, TabState> = new Map();
  private _activeTabId: number = 1;
  private _nextTabId: number = 2;

  constructor(private messenger: WebviewMessenger) {}

  /** Get the currently active tab ID */
  get activeTabId(): number {
    return this._activeTabId;
  }

  /** Create a new empty tab state */
  createTabState(): TabState {
    return {
      ptyProcesses: new Map(),
      terminalProjects: new Map(),
      idleTimers: new Map(),
      terminalBusy: new Map(),
      claudeCommandTimeouts: new Map(),
    };
  }

  /** Get tab state by ID */
  getTabState(tabId: number): TabState | undefined {
    return this.tabs.get(tabId);
  }

  /** Get the active tab state */
  getActiveTabState(): TabState | undefined {
    return this.tabs.get(this._activeTabId);
  }

  /** Check if a tab exists */
  hasTab(tabId: number): boolean {
    return this.tabs.has(tabId);
  }

  /** Get all tab IDs */
  getTabIds(): number[] {
    return Array.from(this.tabs.keys());
  }

  /** Get all tabs (for iteration) */
  getAllTabs(): Map<number, TabState> {
    return this.tabs;
  }

  /** Get total tab count */
  get tabCount(): number {
    return this.tabs.size;
  }

  /** Initialize first tab (called on provider resolve) */
  initializeFirstTab(): void {
    if (this.tabs.size === 0) {
      this.tabs.set(1, this.createTabState());
    }
  }

  /** Create a new tab and notify webview */
  createTab(): number {
    const newTabId = this._nextTabId++;
    this.tabs.set(newTabId, this.createTabState());
    this._activeTabId = newTabId;
    this.messenger.sendTabCreated(newTabId);
    return newTabId;
  }

  /** Switch to a different tab */
  switchTab(tabId: number): void {
    if (this.tabs.has(tabId)) {
      this._activeTabId = tabId;
      this.messenger.sendTabSwitched(tabId);
    }
  }

  /**
   * Close a tab and handle cleanup
   * @param tabId Tab ID to close
   * @param cleanupTerminals Callback to cleanup terminal resources
   * @returns Promise that resolves when tab is closed (or user cancels)
   */
  async closeTab(
    tabId: number,
    cleanupTerminals: (tabId: number) => void
  ): Promise<void> {
    const tabState = this.getTabState(tabId);
    if (!tabState) return;

    // Check if tab has active terminals
    if (tabState.ptyProcesses.size > 0) {
      const answer = await vscode.window.showWarningMessage(
        `Tab ${tabId} has ${tabState.ptyProcesses.size} active terminal(s). Close anyway?`,
        { modal: true },
        'Yes',
        'No'
      );
      if (answer !== 'Yes') return;
    }

    // Cleanup all terminals in this tab
    cleanupTerminals(tabId);

    // Remove tab
    this.tabs.delete(tabId);

    // If this was the active tab, switch to another
    if (this._activeTabId === tabId) {
      const remainingTabs = Array.from(this.tabs.keys());
      if (remainingTabs.length > 0) {
        this._activeTabId = remainingTabs[0];
      } else {
        // Create new tab if none left
        this.tabs.set(1, this.createTabState());
        this._activeTabId = 1;
        this._nextTabId = 2;
      }
    }

    this.messenger.sendTabClosed(tabId, this._activeTabId);
  }

  /** Reset all tabs (used during refresh) */
  reset(): void {
    this.tabs.clear();
    this.tabs.set(1, this.createTabState());
    this._activeTabId = 1;
    this._nextTabId = 2;
  }
}
