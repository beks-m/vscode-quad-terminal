import * as vscode from 'vscode';
import { WebviewToExtensionMessage } from '../types';
import { isValidTerminalId } from '../constants';
import { WebviewMessenger } from './webview-messenger';
import { TabManager } from './tab-manager';
import { ConfigService } from './config-service';
import { TerminalManager } from './terminal-manager';
import { FileOperations } from './file-operations';
import { getWebviewHtml } from './webview-html';

/**
 * Main provider class that orchestrates all terminal operations
 */
export class QuadTerminalViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private messenger: WebviewMessenger;
  private tabManager: TabManager;
  private configService: ConfigService;
  private terminalManager: TerminalManager;
  private fileOperations: FileOperations;

  constructor(private readonly _extensionUri: vscode.Uri) {
    // Initialize messenger with getter for view
    this.messenger = new WebviewMessenger(() => this._view);

    // Initialize tab manager
    this.tabManager = new TabManager(this.messenger);

    // Initialize config service
    this.configService = new ConfigService();

    // Initialize terminal manager
    this.terminalManager = new TerminalManager(this.tabManager, this.messenger);

    // Initialize file operations
    this.fileOperations = new FileOperations(this.tabManager, this.messenger);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    // Initialize first tab
    this.tabManager.initializeFirstTab();

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    // Handle messages from the webview - must be registered BEFORE setting HTML
    // to avoid race condition where webview sends 'ready' before listener exists
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => {
        this.handleMessage(message);
      }
    );

    webviewView.webview.html = getWebviewHtml(webviewView.webview, this._extensionUri);

    // Update projects when workspace folders change
    const workspaceFolderListener = vscode.workspace.onDidChangeWorkspaceFolders(
      () => {
        this.sendProjectsToWebview();
      }
    );

    // Update terminal theme when VS Code theme changes
    const themeChangeListener = vscode.window.onDidChangeActiveColorTheme(() => {
      this.sendTerminalConfig();
    });

    // Clean up all resources when view is disposed
    webviewView.onDidDispose(() => {
      workspaceFolderListener.dispose();
      themeChangeListener.dispose();
      this.disposeAllResources();
    });
  }

  private handleMessage(message: WebviewToExtensionMessage): void {
    const activeTabId = this.tabManager.activeTabId;

    switch (message.command) {
      case 'ready':
        this.sendProjectsToWebview();
        this.sendTerminalConfig();
        break;

      case 'selectProject':
        if (isValidTerminalId(message.terminalId)) {
          const tabId = message.tabId || activeTabId;
          this.terminalManager.startTerminal(
            tabId,
            message.terminalId,
            message.projectPath,
            message.resume
          );
        }
        break;

      case 'input':
        if (isValidTerminalId(message.terminalId)) {
          const tabId = message.tabId || activeTabId;
          this.terminalManager.handleInput(tabId, message.terminalId, message.data);
        }
        break;

      case 'resize':
        if (isValidTerminalId(message.terminalId)) {
          const tabId = message.tabId || activeTabId;
          this.terminalManager.handleResize(
            tabId,
            message.terminalId,
            message.cols,
            message.rows
          );
        }
        break;

      case 'kill':
        if (isValidTerminalId(message.terminalId)) {
          const tabId = message.tabId || activeTabId;
          this.terminalManager.killTerminal(tabId, message.terminalId);
        }
        break;

      case 'restart':
        if (isValidTerminalId(message.terminalId)) {
          const tabId = message.tabId || activeTabId;
          this.terminalManager.restartTerminal(tabId, message.terminalId);
        }
        break;

      case 'resolveDrop':
        if (isValidTerminalId(message.terminalId)) {
          const tabId = message.tabId || activeTabId;
          this.fileOperations.resolveDropData(tabId, message.terminalId, message.data);
        }
        break;

      case 'openFile':
        this.fileOperations.openFileInEditor(
          message.filePath,
          message.line,
          message.column,
          message.tabId,
          message.terminalId
        );
        break;

      case 'openUrl':
        this.fileOperations.openUrl(message.url);
        break;

      case 'pickFiles':
        if (isValidTerminalId(message.terminalId)) {
          this.fileOperations.pickFilesForTerminal(
            message.tabId || activeTabId,
            message.terminalId
          );
        }
        break;

      case 'createTab':
        this.tabManager.createTab();
        break;

      case 'switchTab':
        this.tabManager.switchTab(message.tabId);
        break;

      case 'closeTab':
        this.tabManager.closeTab(message.tabId, (tabId) => {
          this.terminalManager.cleanupAllTerminalsInTab(tabId);
        });
        break;
    }
  }

  private sendProjectsToWebview(): void {
    const projects = this.configService.getWorkspaceProjects();
    this.messenger.sendProjects(projects);
  }

  private sendTerminalConfig(): void {
    const config = this.configService.getTerminalConfig();
    this.messenger.sendTerminalConfig(config);
  }

  private disposeAllResources(): void {
    this.terminalManager.disposeAll();
    this.tabManager.reset();
  }

  public refresh(): void {
    this.disposeAllResources();
    this.messenger.sendRefresh();
    this.sendProjectsToWebview();
  }

  public dispose(): void {
    this.disposeAllResources();
  }
}
