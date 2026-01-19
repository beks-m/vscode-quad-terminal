import * as vscode from 'vscode';
import * as path from 'path';
import { DropData } from '../types';
import { TabManager } from './tab-manager';
import { WebviewMessenger } from './webview-messenger';

/**
 * Handles file-related operations: drop resolution, file picker, open file
 */
export class FileOperations {
  constructor(
    private tabManager: TabManager,
    private messenger: WebviewMessenger
  ) {}

  /**
   * Resolve dropped data into file paths
   */
  resolveDropData(tabId: number, terminalId: number, data: DropData): void {
    const paths: string[] = [];

    // Helper to extract path from URI string
    const extractPath = (uri: string): string | null => {
      if (!uri) return null;
      uri = uri.trim();
      if (!uri || uri.startsWith('#')) return null;

      if (uri.startsWith('file://')) {
        try {
          const fileUri = vscode.Uri.parse(uri);
          return fileUri.fsPath;
        } catch {
          // Fallback: manual parsing
          let filePath = decodeURIComponent(uri.slice(7));
          if (filePath.length > 2 && filePath[0] === '/' && filePath[2] === ':') {
            filePath = filePath.slice(1);
          }
          return filePath;
        }
      } else if (
        uri.startsWith('vscode-resource:') ||
        uri.startsWith('vscode-webview-resource:')
      ) {
        // These can't be easily converted back, skip
        return null;
      } else if (uri.startsWith('/') || /^[A-Za-z]:[/\\]/.test(uri)) {
        return uri;
      }
      return null;
    };

    // Try VS Code resourceurls
    if (data.resourceUrls) {
      try {
        const resources = JSON.parse(data.resourceUrls);
        resources.forEach((r: string) => {
          const filePath = extractPath(r);
          if (filePath) paths.push(filePath);
        });
      } catch {
        // Failed to parse resourceUrls
      }
    }

    // Try codefiles
    if (paths.length === 0 && data.codeFiles) {
      try {
        const files = JSON.parse(data.codeFiles);
        files.forEach((f: string) => {
          const filePath = extractPath(f);
          if (filePath) paths.push(filePath);
        });
      } catch {
        // Failed to parse codeFiles
      }
    }

    // Process URI list
    if (paths.length === 0 && data.uriList) {
      data.uriList.split(/\r?\n/).forEach(uri => {
        const filePath = extractPath(uri);
        if (filePath) paths.push(filePath);
      });
    }

    // Process plain text
    if (paths.length === 0 && data.text) {
      data.text.split(/\r?\n/).forEach(line => {
        const filePath = extractPath(line);
        if (filePath) paths.push(filePath);
      });
    }

    // Send resolved paths to terminal
    if (paths.length > 0) {
      const tabState = this.tabManager.getTabState(tabId);
      const ptyProcess = tabState?.ptyProcesses.get(terminalId);
      if (ptyProcess) {
        const quotedPaths = paths.map(p => (p.includes(' ') ? `"${p}"` : p));
        this.messenger.sendDropResolved(
          tabId,
          terminalId,
          quotedPaths.join(' ')
        );
      }
    }
  }

  /**
   * Open a file in VS Code editor
   */
  async openFileInEditor(
    filePath: string,
    line?: number,
    column?: number,
    tabId?: number,
    terminalId?: number
  ): Promise<void> {
    try {
      // Resolve relative paths using the terminal's working directory
      let absolutePath = filePath;
      if (
        !path.isAbsolute(filePath) &&
        tabId !== undefined &&
        terminalId !== undefined
      ) {
        const tabState = this.tabManager.getTabState(tabId);
        const projectPath = tabState?.terminalProjects.get(terminalId);
        if (projectPath) {
          absolutePath = path.join(projectPath, filePath);
        }
      }

      const uri = vscode.Uri.file(absolutePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
        preserveFocus: false,
      });

      // Navigate to line and column if specified
      if (line !== undefined && line > 0) {
        const lineIndex = line - 1; // VS Code uses 0-based line numbers
        const colIndex = column !== undefined && column > 0 ? column - 1 : 0;
        const position = new vscode.Position(lineIndex, colIndex);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenter
        );
      }
    } catch (error) {
      console.error(`[QuadTerminal] Failed to open file: ${filePath}`, error);
    }
  }

  /**
   * Open file picker and send selected paths to terminal
   */
  async pickFilesForTerminal(tabId: number, terminalId: number): Promise<void> {
    const tabState = this.tabManager.getTabState(tabId);
    const projectPath = tabState?.terminalProjects.get(terminalId);

    const result = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFolders: true,
      canSelectFiles: true,
      defaultUri: projectPath ? vscode.Uri.file(projectPath) : undefined,
      title: 'Select files to insert path',
    });

    if (result && result.length > 0) {
      const paths = result.map(uri => {
        const p = uri.fsPath;
        return p.includes(' ') ? `"${p}"` : p;
      });

      const ptyProcess = tabState?.ptyProcesses.get(terminalId);
      if (ptyProcess) {
        ptyProcess.write(paths.join(' '));
      }
    }
  }

  /**
   * Open URL in external browser
   */
  openUrl(url: string): void {
    vscode.env.openExternal(vscode.Uri.parse(url));
  }
}
