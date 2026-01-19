import * as vscode from 'vscode';
import { Project, TerminalConfig, TerminalColors } from '../types';

/**
 * Service for reading VS Code configuration and building terminal config
 */
export class ConfigService {
  /** Get workspace projects from open folders */
  getWorkspaceProjects(): Project[] {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.map(folder => ({
      name: folder.name,
      path: folder.uri.fsPath,
    }));
  }

  /** Build terminal configuration from VS Code settings */
  getTerminalConfig(): TerminalConfig {
    const config = vscode.workspace.getConfiguration('terminal.integrated');
    const editorConfig = vscode.workspace.getConfiguration('editor');

    // Get terminal colors from workbench color customizations
    const workbenchConfig = vscode.workspace.getConfiguration('workbench');
    const colorCustomizations =
      workbenchConfig.get<Record<string, string>>('colorCustomizations') || {};

    // Use VS Code's actual theme kind for reliable detection
    const themeKind = vscode.window.activeColorTheme.kind;
    const isDark =
      themeKind === vscode.ColorThemeKind.Dark ||
      themeKind === vscode.ColorThemeKind.HighContrast;

    const colors = this.buildTerminalColors(colorCustomizations);

    return {
      fontFamily:
        config.get<string>('fontFamily') ||
        editorConfig.get<string>('fontFamily') ||
        'Menlo, Monaco, monospace',
      fontSize: config.get<number>('fontSize') || 12,
      lineHeight: config.get<number>('lineHeight') || 1.2,
      cursorStyle: config.get<string>('cursorStyle') || 'block',
      cursorBlink: config.get<boolean>('cursorBlinking') !== false,
      colors,
      isDark,
    };
  }

  private buildTerminalColors(
    colorCustomizations: Record<string, string>
  ): TerminalColors {
    return {
      background:
        colorCustomizations['terminal.background'] ||
        colorCustomizations['editor.background'] ||
        '',
      foreground:
        colorCustomizations['terminal.foreground'] ||
        colorCustomizations['editor.foreground'] ||
        '',
      cursor: colorCustomizations['terminalCursor.foreground'] || '',
      cursorAccent: colorCustomizations['terminalCursor.background'] || '',
      selectionBackground:
        colorCustomizations['terminal.selectionBackground'] || '',
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
      brightWhite: colorCustomizations['terminal.ansiBrightWhite'] || '',
    };
  }
}
