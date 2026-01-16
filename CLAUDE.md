# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
# Install dependencies
npm install

# Rebuild node-pty for VS Code's Electron version (required after npm install)
npx @electron/rebuild -f -w node-pty -v 32.0.0

# Compile TypeScript
npm run compile

# Watch mode (auto-recompile on changes)
npm run watch

# Package as .vsix for distribution
npm run package
```

## Development Workflow

Press `F5` in VS Code to launch the Extension Development Host with the extension loaded. The `npm: watch` task runs automatically as a pre-launch task.

## Architecture

This is a VS Code extension that provides a dynamic terminal grid (1-4 terminals) for running Claude CLI sessions.

### Single-File Structure

The entire extension lives in `src/extension.ts`:

- **Extension Entry**: `activate()` registers the webview provider and commands
- **QuadTerminalViewProvider**: Main class that manages up to 4 terminals
  - Creates PTY processes using `node-pty` for real terminal emulation
  - Renders terminals using xterm.js loaded via CDN in the webview
  - Handles bidirectional communication: webview <-> extension <-> PTY
- **Webview HTML**: Generated inline by `_getHtmlForWebview()` - contains all HTML, CSS, and JavaScript

### UI Structure

The webview consists of:

1. **Control Panel** (top bar):
   - Global project selector dropdown
   - Resume session checkbox
   - "Add Terminal" button (disabled until project is selected)
   - Terminal count display (e.g., "2 / 4")

2. **Terminal Grid** (main area):
   - Starts with 1 terminal taking full space
   - 2 terminals: vertical stack layout
   - 3-4 terminals: 2x2 grid layout
   - Each terminal has a header with title, fullscreen toggle, and kill button

### Key Data Flows

1. **Adding Terminals**: User selects project in global dropdown → clicks "Add Terminal" → webview finds empty slot or adds new terminal → sends `selectProject` message → extension spawns PTY in that directory → auto-runs `claude --dangerously-skip-permissions`
2. **Terminal I/O**: PTY output → `onData` handler → postMessage to webview → xterm.write(); User input → xterm.onData → postMessage → pty.write()
3. **Status Tracking**: PTY output triggers busy state (yellow pulse) → idle timer (2s) resets to idle (green) when output stops
4. **Drag and Drop**: Files dragged into terminal → extract paths from `text/uri-list` or `text/plain` → send as terminal input
5. **Fullscreen Mode**: Toggle button → uses absolute positioning to expand terminal over grid

### Terminal State Maps

The provider maintains several `Map<number, T>` structures keyed by terminal ID (0-3):
- `ptyProcesses`: Active PTY instances
- `terminalProjects`: Current working directory paths
- `idleTimers`: Timers for busy/idle status transitions
- `terminalBusy`: Current busy state
- `claudeCommandTimeouts`: Pending claude command execution timers

### Frontend State (Webview JavaScript)

- `visibleTerminalCount`: Number of visible terminal slots (1-4)
- `terminalProjects[]`: Array tracking which terminals have active projects
- `terminalInitialized[]`: Array tracking which terminals have xterm instances
- `terminals[]`: Array of xterm.js Terminal instances
- `fitAddons[]`: Array of FitAddon instances for terminal resizing

### Webview-Extension Communication

Messages use a simple `{command: string, ...data}` format. Key commands:
- Extension → Webview: `projects`, `terminalConfig`, `output`, `clear`, `killed`, `status`, `refresh`
- Webview → Extension: `ready`, `selectProject`, `input`, `resize`, `kill`
