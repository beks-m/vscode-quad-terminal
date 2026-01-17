# Tabs Feature Design

Each tab is a quad terminal instance (1-4 terminals). Users can have unlimited tabs.

## Data Model

**Extension side:**

```typescript
interface TabState {
  terminals: Map<number, pty.IPty>;       // 0-3 -> PTY
  projects: Map<number, string>;          // 0-3 -> path
  busyState: Map<number, boolean>;
  idleTimers: Map<number, NodeJS.Timeout>;
  claudeTimeouts: Map<number, NodeJS.Timeout>;
}

// Provider properties
tabs: Map<number, TabState>;              // tabId -> TabState
activeTabId: number;
nextTabId: number;
```

**Webview side:**

```javascript
tabs = {
  1: { terminals: [], fitAddons: [], projects: [], initialized: [] },
  2: { ... }
};
activeTabId = 1;
nextTabId = 2;
```

## UI Layout

```
┌─────────────────────────────────────────────────────────────┐
│ [Tab 1][Tab 2][+]  │  [Project ▼]  [☑ Resume]  [+ Add]  2/4 │
└─────────────────────────────────────────────────────────────┘
│                        Terminal Grid                        │
└─────────────────────────────────────────────────────────────┘
```

- Tab bar integrated into left side of control panel
- "+" button creates new tab
- Each tab has "×" close button (visible on hover)
- Active tab highlighted with accent color
- Background tabs show activity indicator if terminals are busy

## Message Protocol

New commands:

| Direction | Command | Data |
|-----------|---------|------|
| Webview → Extension | `createTab` | — |
| Webview → Extension | `switchTab` | `{ tabId }` |
| Webview → Extension | `closeTab` | `{ tabId }` |
| Extension → Webview | `tabCreated` | `{ tabId }` |
| Extension → Webview | `tabClosed` | `{ tabId }` |
| Extension → Webview | `tabSwitched` | `{ tabId }` |

Existing messages (`selectProject`, `input`, `output`, `kill`, etc.) include `tabId`.

## Behaviors

### Tab Creation
1. Click "+" → `createTab` message
2. Extension creates `TabState`, assigns ID
3. Sends `tabCreated` → webview adds tab button and empty grid
4. Auto-switches to new tab

### Auto-Create When Full
1. "Add Terminal" clicked when current tab has 4 terminals
2. Extension creates new tab automatically
3. Switches to new tab, adds terminal in slot 0

### Tab Closing
1. Click "×" on tab with active terminals
2. VS Code confirmation dialog via `vscode.window.showWarningMessage()`
3. If confirmed → kills all PTYs, removes state, sends `tabClosed`
4. If last tab → auto-create new empty Tab 1

### Tab Switching
- Hides current grid, shows new tab's grid
- xterm instances persist (not destroyed)
- PTY processes keep running in background

## Tab Labels

Auto-numbered: "Tab 1", "Tab 2", etc.

## Constraints

- Minimum 1 tab always exists
- Unlimited tabs allowed
- Each tab supports 1-4 terminals
