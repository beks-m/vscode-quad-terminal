# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
# Install dependencies
npm install

# Rebuild node-pty for VS Code's Electron version (required after npm install)
npx @electron/rebuild -f -w node-pty -v 32.0.0

# Compile TypeScript and copy webview files
npm run compile

# Watch mode (auto-recompile on changes)
npm run watch

# Package as .vsix for distribution
npm run package
```

## Development Workflow

Press `F5` in VS Code to launch the Extension Development Host with the extension loaded. The `npm: watch` task runs automatically as a pre-launch task.

## Architecture

This is a VS Code extension that provides a dynamic terminal grid (1-4 terminals per tab) for running Claude CLI sessions.

### Directory Structure

```
src/
├── extension.ts                    # Entry point (minimal)
├── constants.ts                    # Shared constants
├── types/
│   ├── index.ts                    # Re-exports
│   ├── state.ts                    # TabState, TerminalConfig, Project
│   └── messages.ts                 # Type-safe message definitions
├── provider/
│   ├── index.ts                    # QuadTerminalViewProvider (orchestrator)
│   ├── terminal-manager.ts         # PTY lifecycle, I/O, status
│   ├── tab-manager.ts              # Tab state management
│   ├── config-service.ts           # Terminal config, projects
│   ├── file-operations.ts          # Drop resolution, file picker
│   ├── webview-messenger.ts        # Type-safe message sending
│   └── webview-html.ts             # HTML generation from templates
└── webview/
    ├── index.html                  # HTML template
    ├── styles/
    │   └── main.css                # All CSS styles
    └── scripts/
        └── main.js                 # Webview JavaScript
```

### Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| `extension.ts` | Entry point, registers provider and commands |
| `constants.ts` | TERMINAL_COUNT, timeouts, validation |
| `types/` | TypeScript interfaces for state and messages |
| `provider/index.ts` | Orchestrates all modules, handles messages |
| `terminal-manager.ts` | PTY create/destroy, I/O, busy/idle status |
| `tab-manager.ts` | Tab state (Map<tabId, TabState>), switching |
| `config-service.ts` | Reads VS Code config, builds terminal theme |
| `file-operations.ts` | Resolve drops, open files, file picker |
| `webview-messenger.ts` | Type-safe postMessage wrapper |
| `webview-html.ts` | Loads and assembles HTML from files |

### Type-Safe Message Protocol

Messages between extension and webview use discriminated unions:

```typescript
// Webview → Extension
type WebviewToExtensionMessage =
  | { command: 'ready' }
  | { command: 'selectProject'; tabId: number; terminalId: number; ... }
  | { command: 'input'; tabId: number; terminalId: number; data: string }
  | ...

// Extension → Webview
type ExtensionToWebviewMessage =
  | { command: 'projects'; projects: Project[] }
  | { command: 'output'; tabId: number; terminalId: number; data: string }
  | { command: 'status'; tabId: number; terminalId: number; status: 'busy' | 'idle' }
  | ...
```

### UI Structure

The webview consists of:

1. **Tab Bar**: Multiple tabs, each with its own terminal grid
2. **Control Panel** (top bar):
   - Tab buttons with activity indicators
   - Project selector dropdown
   - Resume session checkbox
   - "Add Terminal" button
   - Terminal count display (e.g., "2 / 4")

3. **Terminal Grid** (main area):
   - Starts with 1 terminal taking full space
   - 2 terminals: vertical stack layout
   - 3-4 terminals: 2x2 grid layout
   - Each terminal has a header with title, fullscreen toggle, restart, and kill buttons

### Key Data Flows

1. **Adding Terminals**: User selects project → clicks "Add Terminal" → webview sends `selectProject` → extension spawns PTY → auto-runs `claude --dangerously-skip-permissions`
2. **Terminal I/O**: PTY output → `TerminalManager.sendOutput()` → webview `xterm.write()`; User input → `xterm.onData` → extension `pty.write()`
3. **Status Tracking**: PTY output triggers busy state → idle timer (2s) transitions to idle
4. **Tab Management**: Each tab has independent terminal state (up to 4 terminals per tab)
5. **Drag and Drop**: Files dragged into terminal → resolved to paths → sent as terminal input

### Tab State Structure

```typescript
interface TabState {
  ptyProcesses: Map<number, pty.IPty>;      // Terminal ID → PTY
  terminalProjects: Map<number, string>;     // Terminal ID → project path
  idleTimers: Map<number, NodeJS.Timeout>;   // Terminal ID → idle timer
  terminalBusy: Map<number, boolean>;        // Terminal ID → busy state
  claudeCommandTimeouts: Map<number, NodeJS.Timeout>;
}
```

### Webview State (main.js)

```javascript
const tabState = {
  [tabId]: {
    terminals: [],              // xterm.js Terminal instances
    fitAddons: [],              // FitAddon instances
    terminalInitialized: [],    // Which terminals have xterm
    terminalProjects: [],       // Project paths
    visibleTerminalCount: 1     // Number of visible slots
  }
};
```

### Adding New Message Types

1. Add to `src/types/messages.ts`
2. Add handler in `provider/index.ts` `handleMessage()`
3. Add sender method in `webview-messenger.ts` if extension→webview
4. Add case in `main.js` message listener if needed
