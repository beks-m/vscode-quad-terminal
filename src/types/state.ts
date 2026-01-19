import * as pty from 'node-pty';

/**
 * Represents a workspace project that can be opened in a terminal
 */
export interface Project {
  name: string;
  path: string;
}

/**
 * Terminal configuration received from VS Code settings
 */
export interface TerminalConfig {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: string;
  cursorBlink: boolean;
  colors: TerminalColors;
  isDark: boolean;
}

/**
 * Terminal color theme configuration
 */
export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * State for a single tab containing up to 4 terminals
 */
export interface TabState {
  /** Map of terminal ID (0-3) to PTY process */
  ptyProcesses: Map<number, pty.IPty>;
  /** Map of terminal ID to project path */
  terminalProjects: Map<number, string>;
  /** Map of terminal ID to idle timeout timer */
  idleTimers: Map<number, NodeJS.Timeout>;
  /** Map of terminal ID to busy state */
  terminalBusy: Map<number, boolean>;
  /** Map of terminal ID to pending claude command timeout */
  claudeCommandTimeouts: Map<number, NodeJS.Timeout>;
}

/**
 * Terminal ID type - valid values are 0, 1, 2, 3
 */
export type TerminalId = 0 | 1 | 2 | 3;

/**
 * Tab ID type - positive integers starting from 1
 */
export type TabId = number;

/**
 * Terminal status for UI display
 */
export type TerminalStatus = 'idle' | 'busy';
