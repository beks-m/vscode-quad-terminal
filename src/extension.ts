import * as vscode from 'vscode';
import { QuadTerminalViewProvider } from './provider';

// Store provider reference for cleanup on deactivate
let providerInstance: QuadTerminalViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('Quad Terminal is now active!');

  const provider = new QuadTerminalViewProvider(context.extensionUri);
  providerInstance = provider;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('quadTerminal.grid', provider, {
      webviewOptions: { retainContextWhenHidden: true },
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

  context.subscriptions.push(
    vscode.commands.registerCommand('quadTerminal.newTerminal', () => {
      provider.newTerminal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('quadTerminal.newTab', () => {
      provider.newTab();
    })
  );
}

export function deactivate() {
  // Kill all terminal processes when extension deactivates
  if (providerInstance) {
    providerInstance.dispose();
    providerInstance = undefined;
  }
}
