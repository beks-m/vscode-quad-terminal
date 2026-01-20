# Session Picker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enhance the project chooser to show recent Claude Code sessions when a project is selected, replacing the resume checkbox with an inline session picker.

**Architecture:** When a project is selected, the extension fetches sessions from `~/.claude/projects/<encoded-path>/`, extracts last user messages from JSONL files, and sends them to the webview. The webview renders an expandable session panel that appears inline next to the dropdown.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js fs module, xterm.js webview

---

## Task 1: Add Session Type Definition

**Files:**
- Modify: `src/types/state.ts:81` (end of file)

**Step 1: Add Session interface**

Add at the end of `src/types/state.ts`:

```typescript
/**
 * Represents a Claude Code session for a project
 */
export interface Session {
  sessionId: string;
  lastMessage: string;
  lastModified: string; // ISO timestamp
}
```

**Step 2: Verify compilation**

Run: `npm run compile`
Expected: No errors

**Step 3: Commit**

```bash
git add src/types/state.ts
git commit -m "feat: add Session type definition"
```

---

## Task 2: Add Message Types for Sessions

**Files:**
- Modify: `src/types/messages.ts`

**Step 1: Add GetSessionsMessage after CloseTabMessage (line ~93)**

```typescript
export interface GetSessionsMessage {
  command: 'getSessions';
  projectPath: string;
}
```

**Step 2: Update WebviewToExtensionMessage union (line ~96)**

Add `| GetSessionsMessage` to the union type.

**Step 3: Import Session type at top of file**

Update line 1:
```typescript
import { Project, TerminalConfig, TerminalStatus, Session } from './state';
```

**Step 4: Add SessionsMessage after RestartingMessage (line ~189)**

```typescript
export interface SessionsMessage {
  command: 'sessions';
  projectPath: string;
  sessions: Session[];
}
```

**Step 5: Update ExtensionToWebviewMessage union (line ~191)**

Add `| SessionsMessage` to the union type.

**Step 6: Update SelectProjectMessage to include optional sessionId**

Modify the existing interface (around line 11-17):
```typescript
export interface SelectProjectMessage {
  command: 'selectProject';
  tabId: number;
  terminalId: number;
  projectPath: string;
  sessionId?: string; // Optional: specific session to resume
}
```

**Step 7: Verify compilation**

Run: `npm run compile`
Expected: No errors

**Step 8: Commit**

```bash
git add src/types/messages.ts
git commit -m "feat: add session message types"
```

---

## Task 3: Update types/index.ts Export

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Read current exports**

Check `src/types/index.ts` to see what's exported.

**Step 2: Ensure Session is exported**

If using barrel exports, ensure `Session` is re-exported from state.ts.

**Step 3: Verify compilation**

Run: `npm run compile`
Expected: No errors

**Step 4: Commit if changes made**

```bash
git add src/types/index.ts
git commit -m "feat: export Session type"
```

---

## Task 4: Implement Session Fetching in Extension

**Files:**
- Create: `src/provider/session-service.ts`

**Step 1: Create session-service.ts**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Session } from '../types';

/**
 * Service for fetching Claude Code sessions
 */
export class SessionService {
  private claudeDir: string;

  constructor() {
    this.claudeDir = path.join(os.homedir(), '.claude', 'projects');
  }

  /**
   * Encode project path for Claude directory lookup
   * /Users/foo/bar -> -Users-foo-bar
   */
  private encodeProjectPath(projectPath: string): string {
    return projectPath.replace(/\//g, '-');
  }

  /**
   * Get relative time string from date
   */
  private getRelativeTime(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  /**
   * Extract last user message from a session JSONL file
   */
  private extractLastUserMessage(sessionPath: string): string | null {
    try {
      const content = fs.readFileSync(sessionPath, 'utf-8');
      const lines = content.trim().split('\n').reverse();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.message?.content) {
            // Skip tool results
            const content = entry.message.content;
            if (typeof content === 'string' && !content.includes('tool_result')) {
              return content.slice(0, 60);
            }
            if (Array.isArray(content)) {
              const textPart = content.find((p: any) => p.type === 'text');
              if (textPart?.text && !textPart.text.includes('tool_result')) {
                return textPart.text.slice(0, 60);
              }
            }
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    } catch {
      // File read error
    }
    return null;
  }

  /**
   * Get recent sessions for a project
   */
  async getSessions(projectPath: string, limit: number = 5): Promise<Session[]> {
    const encodedPath = this.encodeProjectPath(projectPath);
    const projectDir = path.join(this.claudeDir, encodedPath);

    if (!fs.existsSync(projectDir)) {
      return [];
    }

    const sessions: Session[] = [];

    try {
      // Try sessions-index.json first
      const indexPath = path.join(projectDir, 'sessions-index.json');
      if (fs.existsSync(indexPath)) {
        const indexContent = fs.readFileSync(indexPath, 'utf-8');
        const index = JSON.parse(indexContent);

        if (index.entries && Array.isArray(index.entries)) {
          // Sort by modified date descending
          const sorted = index.entries
            .filter((e: any) => e.sessionId && e.modified)
            .sort((a: any, b: any) =>
              new Date(b.modified).getTime() - new Date(a.modified).getTime()
            )
            .slice(0, limit);

          for (const entry of sorted) {
            const sessionFile = path.join(projectDir, `${entry.sessionId}.jsonl`);
            const lastMessage = this.extractLastUserMessage(sessionFile);

            if (lastMessage) {
              sessions.push({
                sessionId: entry.sessionId,
                lastMessage,
                lastModified: this.getRelativeTime(new Date(entry.modified))
              });
            }
          }
        }
      } else {
        // Fallback: read JSONL files directly sorted by mtime
        const files = fs.readdirSync(projectDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({
            name: f,
            path: path.join(projectDir, f),
            mtime: fs.statSync(path.join(projectDir, f)).mtime
          }))
          .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
          .slice(0, limit);

        for (const file of files) {
          const lastMessage = this.extractLastUserMessage(file.path);
          if (lastMessage) {
            sessions.push({
              sessionId: file.name.replace('.jsonl', ''),
              lastMessage,
              lastModified: this.getRelativeTime(file.mtime)
            });
          }
        }
      }
    } catch (error) {
      console.error('[SessionService] Error reading sessions:', error);
    }

    return sessions;
  }
}
```

**Step 2: Verify compilation**

Run: `npm run compile`
Expected: No errors

**Step 3: Commit**

```bash
git add src/provider/session-service.ts
git commit -m "feat: add SessionService for fetching Claude sessions"
```

---

## Task 5: Add Sessions Message Handler to Provider

**Files:**
- Modify: `src/provider/index.ts`

**Step 1: Import SessionService**

Add after line 8:
```typescript
import { SessionService } from './session-service';
```

**Step 2: Add sessionService property**

Add after `fileOperations` declaration (around line 20):
```typescript
private sessionService: SessionService;
```

**Step 3: Initialize sessionService in constructor**

Add after `this.fileOperations = ...` (around line 37):
```typescript
this.sessionService = new SessionService();
```

**Step 4: Add getSessions case in handleMessage**

Add after the `closeTab` case (around line 180):
```typescript
      case 'getSessions':
        this.handleGetSessions(message.projectPath);
        break;
```

**Step 5: Add handleGetSessions method**

Add before `sendProjectsToWebview` method (around line 183):
```typescript
  private async handleGetSessions(projectPath: string): Promise<void> {
    const sessions = await this.sessionService.getSessions(projectPath, 5);
    this.messenger.sendSessions(projectPath, sessions);
  }
```

**Step 6: Verify compilation**

Run: `npm run compile`
Expected: Error about sendSessions not existing (expected, we'll add it next)

**Step 7: Commit**

```bash
git add src/provider/index.ts
git commit -m "feat: add getSessions message handler"
```

---

## Task 6: Add sendSessions to WebviewMessenger

**Files:**
- Modify: `src/provider/webview-messenger.ts`

**Step 1: Import Session type**

Update the import at line 1:
```typescript
import * as vscode from 'vscode';
import {
  ExtensionToWebviewMessage,
  Project,
  Session,
  TerminalConfig,
  TerminalStatus,
} from '../types';
```

**Step 2: Add sendSessions method**

Add after `sendRestarting` method (around line 85):
```typescript
  /** Send sessions for a project to webview */
  sendSessions(projectPath: string, sessions: Session[]): void {
    this.send({ command: 'sessions', projectPath, sessions });
  }
```

**Step 3: Verify compilation**

Run: `npm run compile`
Expected: No errors

**Step 4: Commit**

```bash
git add src/provider/webview-messenger.ts
git commit -m "feat: add sendSessions to messenger"
```

---

## Task 7: Update Terminal Manager for Session Resume

**Files:**
- Modify: `src/provider/terminal-manager.ts`

**Step 1: Update startTerminal signature**

Change method signature (around line 20-25) to accept sessionId:
```typescript
  startTerminal(
    tabId: number,
    terminalId: number,
    projectPath: string,
    sessionId?: string
  ): void {
```

**Step 2: Update claude command logic**

Replace the claude command section (around lines 72-81):
```typescript
      // Auto-run claude after shell init
      const timeout = setTimeout(() => {
        if (tabState.ptyProcesses.has(terminalId)) {
          let claudeCmd: string;
          if (sessionId) {
            claudeCmd = `claude --dangerously-skip-permissions --resume ${sessionId}\r`;
          } else {
            claudeCmd = 'claude --dangerously-skip-permissions\r';
          }
          ptyProcess.write(claudeCmd);
        }
        tabState.claudeCommandTimeouts.delete(terminalId);
      }, SHELL_INIT_DELAY_MS);
```

**Step 3: Update restartTerminal to not pass sessionId**

Ensure `restartTerminal` (around line 183) passes undefined for sessionId:
```typescript
      this.startTerminal(tabId, terminalId, projectPath);
```

**Step 4: Verify compilation**

Run: `npm run compile`
Expected: No errors

**Step 5: Commit**

```bash
git add src/provider/terminal-manager.ts
git commit -m "feat: support session resume in terminal manager"
```

---

## Task 8: Update Provider to Pass sessionId

**Files:**
- Modify: `src/provider/index.ts`

**Step 1: Update selectProject handler**

Modify the selectProject case (around lines 93-102):
```typescript
      case 'selectProject':
        if (isValidTerminalId(message.terminalId)) {
          const tabId = message.tabId || activeTabId;
          this.terminalManager.startTerminal(
            tabId,
            message.terminalId,
            message.projectPath,
            message.sessionId
          );
        }
        break;
```

**Step 2: Verify compilation**

Run: `npm run compile`
Expected: No errors

**Step 3: Commit**

```bash
git add src/provider/index.ts
git commit -m "feat: pass sessionId to terminal manager"
```

---

## Task 9: Update HTML - Remove Resume Checkbox, Add Session Panel

**Files:**
- Modify: `src/webview/index.html`

**Step 1: Remove resume checkbox label (lines 33-36)**

Delete these lines:
```html
      <label class="resume-label" id="global-resume-label" title="Resume previous Claude session">
        <input type="checkbox" class="resume-checkbox" id="global-resume">
        <svg class="resume-icon" viewBox="0 0 16 16"><path d="M3 3l5 5-5 5V3z"/><path d="M9 3l5 5-5 5V3z"/></svg>
      </label>
```

**Step 2: Wrap project select in a container and add session panel**

Replace the control-panel-section div (lines 27-31) with:
```html
      <div class="control-panel-section">
        <span class="control-label">Project</span>
        <div class="project-selector-wrapper" id="project-selector-wrapper">
          <select class="project-select" id="global-project-select">
            <option value="">Select project...</option>
          </select>
          <div class="session-panel" id="session-panel">
            <div class="session-item new-session" id="new-session-item">
              <svg class="session-icon" viewBox="0 0 16 16"><path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/></svg>
              <span class="session-label">New Session</span>
            </div>
            <div class="session-divider"></div>
            <div class="session-list" id="session-list">
              <div class="session-loading">Loading sessions...</div>
            </div>
          </div>
        </div>
      </div>
```

**Step 3: Verify HTML is valid**

Open the file and check for syntax errors.

**Step 4: Commit**

```bash
git add src/webview/index.html
git commit -m "feat: update HTML for session panel"
```

---

## Task 10: Add CSS Styles for Session Panel

**Files:**
- Modify: `src/webview/styles/main.css`

**Step 1: Add session panel styles after .project-select styles (around line 175)**

```css
/* Session Selector */
.project-selector-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0;
  flex: 1;
  min-width: 0;
}
.project-selector-wrapper.expanded .project-select {
  border-radius: 4px 0 0 4px;
  border-right: none;
}
.session-panel {
  display: none;
  background: var(--vscode-dropdown-background, #3c3c3c);
  border: 1px solid var(--vscode-focusBorder, #007acc);
  border-left: none;
  border-radius: 0 4px 4px 0;
  max-width: 280px;
  min-width: 200px;
  overflow: hidden;
}
.project-selector-wrapper.expanded .session-panel {
  display: block;
}
.session-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  transition: background 0.1s ease;
  font-size: 12px;
  color: var(--vscode-dropdown-foreground, #ccc);
}
.session-item:hover {
  background: var(--vscode-list-hoverBackground, rgba(90, 93, 94, 0.4));
}
.session-item.selected {
  background: var(--vscode-list-activeSelectionBackground, #094771);
  color: var(--vscode-list-activeSelectionForeground, #fff);
}
.session-item.new-session {
  font-weight: 500;
  color: var(--vscode-textLink-foreground, #3794ff);
}
.session-icon {
  width: 14px;
  height: 14px;
  fill: currentColor;
  flex-shrink: 0;
}
.session-label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-divider {
  height: 1px;
  background: var(--vscode-editorGroup-border, #333);
  margin: 2px 0;
}
.session-list {
  max-height: 150px;
  overflow-y: auto;
}
.session-list::-webkit-scrollbar {
  width: 6px;
}
.session-list::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
  border-radius: 3px;
}
.session-message {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--vscode-foreground, #ccc);
}
.session-time {
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #888);
  flex-shrink: 0;
}
.session-loading,
.session-empty {
  padding: 8px 10px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #888);
  font-style: italic;
}
```

**Step 2: Add light theme adjustments for session panel (after existing light theme styles, around line 530)**

```css
body.vscode-light .session-panel {
  background: var(--vscode-dropdown-background, #ffffff);
  border-color: var(--vscode-focusBorder, #0066b8);
}
body.vscode-light .session-item:hover {
  background: var(--vscode-list-hoverBackground, #e8e8e8);
}
body.vscode-light .session-divider {
  background: var(--vscode-editorGroup-border, #e7e7e7);
}
```

**Step 3: Verify CSS syntax**

Run: `npm run compile`
Expected: No errors

**Step 4: Commit**

```bash
git add src/webview/styles/main.css
git commit -m "feat: add session panel styles"
```

---

## Task 11: Implement Session Panel Logic in Webview

**Files:**
- Modify: `src/webview/scripts/main.js`

**Step 1: Add session state variables after line 13**

```javascript
// Session selection state
let selectedSession = { type: 'new' }; // { type: 'new' } or { type: 'resume', sessionId: string }
let currentSessions = [];
let sessionPanelOpen = false;
```

**Step 2: Add session panel functions after updateProjectSelectors function (around line 1248)**

```javascript
// Session panel functions
function openSessionPanel() {
  const wrapper = document.getElementById('project-selector-wrapper');
  if (wrapper) {
    wrapper.classList.add('expanded');
    sessionPanelOpen = true;
  }
}

function closeSessionPanel() {
  const wrapper = document.getElementById('project-selector-wrapper');
  if (wrapper) {
    wrapper.classList.remove('expanded');
    sessionPanelOpen = false;
  }
}

function selectSession(session) {
  selectedSession = session;

  // Update UI to show selection
  document.querySelectorAll('.session-item').forEach(item => {
    item.classList.remove('selected');
  });

  if (session.type === 'new') {
    document.getElementById('new-session-item')?.classList.add('selected');
  } else {
    const item = document.querySelector(`.session-item[data-session-id="${session.sessionId}"]`);
    if (item) item.classList.add('selected');
  }

  closeSessionPanel();
  updateAddButtonState();
}

function renderSessions(sessions) {
  const sessionList = document.getElementById('session-list');
  if (!sessionList) return;

  currentSessions = sessions;

  if (sessions.length === 0) {
    sessionList.innerHTML = '<div class="session-empty">No recent sessions</div>';
    return;
  }

  sessionList.innerHTML = sessions.map(session => `
    <div class="session-item" data-session-id="${session.sessionId}">
      <span class="session-message">${escapeHtml(session.lastMessage)}</span>
      <span class="session-time">${escapeHtml(session.lastModified)}</span>
    </div>
  `).join('');

  // Add click handlers
  sessionList.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', function() {
      const sessionId = this.dataset.sessionId;
      selectSession({ type: 'resume', sessionId });
    });
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
```

**Step 3: Update project select change handler**

Replace the existing event listener (line 490) with:
```javascript
// Update button state and fetch sessions when project selection changes
document.getElementById('global-project-select').addEventListener('change', function() {
  const projectPath = this.value;

  // Reset session selection
  selectedSession = { type: 'new' };
  document.querySelectorAll('.session-item').forEach(item => {
    item.classList.remove('selected');
  });
  document.getElementById('new-session-item')?.classList.add('selected');

  if (projectPath) {
    // Show loading state
    const sessionList = document.getElementById('session-list');
    if (sessionList) {
      sessionList.innerHTML = '<div class="session-loading">Loading sessions...</div>';
    }

    // Request sessions from extension
    vscode.postMessage({
      command: 'getSessions',
      projectPath: projectPath
    });

    // Open the session panel
    openSessionPanel();
  } else {
    closeSessionPanel();
  }

  updateAddButtonState();
});
```

**Step 4: Add new session item click handler**

Add after the project select change handler:
```javascript
// New session item click handler
document.getElementById('new-session-item')?.addEventListener('click', function() {
  selectSession({ type: 'new' });
});

// Close session panel when clicking outside
document.addEventListener('click', function(e) {
  const wrapper = document.getElementById('project-selector-wrapper');
  const addBtn = document.getElementById('add-terminal-btn');
  if (wrapper && sessionPanelOpen && !wrapper.contains(e.target) && e.target !== addBtn) {
    closeSessionPanel();
  }
});
```

**Step 5: Add sessions message handler in the message switch**

Add after the `tabSwitched` case (around line 1138):
```javascript
    case 'sessions':
      if (message.projectPath === document.getElementById('global-project-select').value) {
        renderSessions(message.sessions);
      }
      break;
```

**Step 6: Update addTerminal function to use selectedSession**

Modify the addTerminal function (around line 492-543). Replace the resume variable usage:

Find:
```javascript
  var resume = document.getElementById('global-resume').checked;
```

Replace with:
```javascript
  var sessionId = selectedSession.type === 'resume' ? selectedSession.sessionId : null;
```

And update the startTerminalWithProject call. Find the setTimeout block:
```javascript
  setTimeout(function() {
    startTerminalWithProject(tid, projectPath, projectName, resume);
  }, 100);
```

Replace with:
```javascript
  setTimeout(function() {
    startTerminalWithProject(tid, projectPath, projectName, sessionId);
  }, 100);
```

**Step 7: Update startTerminalWithProject function**

Modify the function signature and message (around line 451-480):
```javascript
function startTerminalWithProject(terminalId, projectPath, projectName, sessionId) {
  var tab = getActiveTab();
  if (!tab) return;

  // Initialize the terminal UI
  initializeTerminal(terminalId);

  // Update terminal title
  var titleEl = document.getElementById('terminal-title-' + activeTabId + '-' + terminalId);
  if (titleEl) {
    titleEl.textContent = projectName;
    titleEl.classList.remove('empty');
  }

  // Store project info
  tab.terminalProjects[terminalId] = projectPath;

  // Update status indicator
  var statusEl = document.getElementById('status-' + activeTabId + '-' + terminalId);
  if (statusEl) statusEl.classList.add('active');

  // Send message to extension to start the terminal
  var message = {
    command: 'selectProject',
    tabId: activeTabId,
    terminalId: terminalId,
    projectPath: projectPath
  };
  if (sessionId) {
    message.sessionId = sessionId;
  }
  vscode.postMessage(message);
}
```

**Step 8: Remove resume checkbox references from refresh handler**

In the `refresh` case (around line 1122), remove:
```javascript
      document.getElementById('global-resume').checked = false;
```

**Step 9: Verify no syntax errors**

Run: `npm run compile`
Expected: No errors

**Step 10: Commit**

```bash
git add src/webview/scripts/main.js
git commit -m "feat: implement session panel logic in webview"
```

---

## Task 12: Test the Implementation

**Step 1: Compile the extension**

Run: `npm run compile`
Expected: No errors

**Step 2: Launch Extension Development Host**

Press F5 in VS Code to launch the extension.

**Step 3: Test session panel**

1. Open a project folder that has Claude sessions in `~/.claude/projects/`
2. Select the project from the dropdown
3. Verify session panel appears to the right
4. Verify "New Session" is at the top
5. Verify recent sessions show with last message and timestamp
6. Click a session and verify it becomes selected
7. Click "Add Terminal" and verify it starts with the correct session

**Step 4: Test edge cases**

1. Test project with no sessions (should show "No recent sessions")
2. Test clicking outside panel closes it
3. Test switching projects resets selection and fetches new sessions

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete session picker implementation"
```

---

## Summary

Files created:
- `src/provider/session-service.ts` - Session fetching logic

Files modified:
- `src/types/state.ts` - Added Session interface
- `src/types/messages.ts` - Added session message types
- `src/provider/index.ts` - Added getSessions handler
- `src/provider/webview-messenger.ts` - Added sendSessions method
- `src/provider/terminal-manager.ts` - Support sessionId in startTerminal
- `src/webview/index.html` - Removed resume checkbox, added session panel
- `src/webview/styles/main.css` - Session panel styles
- `src/webview/scripts/main.js` - Session panel logic
