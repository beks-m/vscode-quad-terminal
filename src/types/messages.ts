import { Project, TerminalConfig, TerminalStatus } from './state';

// ============================================
// Webview -> Extension Messages
// ============================================

export interface ReadyMessage {
  command: 'ready';
}

export interface SelectProjectMessage {
  command: 'selectProject';
  tabId: number;
  terminalId: number;
  projectPath: string;
  resume: boolean;
}

export interface InputMessage {
  command: 'input';
  tabId: number;
  terminalId: number;
  data: string;
}

export interface ResizeMessage {
  command: 'resize';
  tabId: number;
  terminalId: number;
  cols: number;
  rows: number;
}

export interface KillMessage {
  command: 'kill';
  tabId: number;
  terminalId: number;
}

export interface RestartMessage {
  command: 'restart';
  tabId: number;
  terminalId: number;
}

export interface ResolveDropMessage {
  command: 'resolveDrop';
  tabId: number;
  terminalId: number;
  data: DropData;
}

export interface DropData {
  uriList?: string;
  text?: string;
  resourceUrls?: string;
  codeFiles?: string;
  types?: string[];
}

export interface OpenFileMessage {
  command: 'openFile';
  filePath: string;
  line?: number;
  column?: number;
  tabId?: number;
  terminalId?: number;
}

export interface OpenUrlMessage {
  command: 'openUrl';
  url: string;
}

export interface PickFilesMessage {
  command: 'pickFiles';
  tabId: number;
  terminalId: number;
}

export interface CreateTabMessage {
  command: 'createTab';
}

export interface SwitchTabMessage {
  command: 'switchTab';
  tabId: number;
}

export interface CloseTabMessage {
  command: 'closeTab';
  tabId: number;
}

/** All messages that can be sent from webview to extension */
export type WebviewToExtensionMessage =
  | ReadyMessage
  | SelectProjectMessage
  | InputMessage
  | ResizeMessage
  | KillMessage
  | RestartMessage
  | ResolveDropMessage
  | OpenFileMessage
  | OpenUrlMessage
  | PickFilesMessage
  | CreateTabMessage
  | SwitchTabMessage
  | CloseTabMessage;

// ============================================
// Extension -> Webview Messages
// ============================================

export interface ProjectsMessage {
  command: 'projects';
  projects: Project[];
}

export interface TerminalConfigMessage {
  command: 'terminalConfig';
  config: TerminalConfig;
}

export interface OutputMessage {
  command: 'output';
  tabId: number;
  terminalId: number;
  data: string;
}

export interface ClearMessage {
  command: 'clear';
  tabId: number;
  terminalId: number;
}

export interface ErrorMessage {
  command: 'error';
  tabId: number;
  terminalId: number;
  message: string;
}

export interface KilledMessage {
  command: 'killed';
  tabId: number;
  terminalId: number;
}

export interface StatusMessage {
  command: 'status';
  tabId: number;
  terminalId: number;
  status: TerminalStatus;
}

export interface DropResolvedMessage {
  command: 'dropResolved';
  tabId: number;
  terminalId: number;
  paths: string;
}

export interface RefreshMessage {
  command: 'refresh';
}

export interface TabCreatedMessage {
  command: 'tabCreated';
  tabId: number;
}

export interface TabClosedMessage {
  command: 'tabClosed';
  tabId: number;
  newActiveTabId: number;
}

export interface TabSwitchedMessage {
  command: 'tabSwitched';
  tabId: number;
}

export interface RestartingMessage {
  command: 'restarting';
  tabId: number;
  terminalId: number;
}

/** All messages that can be sent from extension to webview */
export type ExtensionToWebviewMessage =
  | ProjectsMessage
  | TerminalConfigMessage
  | OutputMessage
  | ClearMessage
  | ErrorMessage
  | KilledMessage
  | StatusMessage
  | DropResolvedMessage
  | RefreshMessage
  | TabCreatedMessage
  | TabClosedMessage
  | TabSwitchedMessage
  | RestartingMessage;
