# Quad Terminal

A VS Code extension that provides 4 terminals in a 2x2 grid layout, each automatically running [Claude CLI](https://github.com/anthropics/claude-code) with project-specific working directories.

## Features

- **2x2 Terminal Grid** - Four independent terminal panels in a grid layout
- **Project Selection** - Dropdown to select workspace folder for each terminal
- **Auto-runs Claude** - Automatically starts Claude CLI when a project is selected
- **Resume Sessions** - Option to resume previous Claude conversation
- **Kill Terminal** - Stop running processes with the trash button
- **Fullscreen Mode** - Expand any terminal to take the full grid space
- **Status Indicator** - Visual feedback showing busy (yellow pulse) or idle (green) state
- **Theme Integration** - Inherits VS Code terminal colors and fonts

## Installation

### From VSIX (Local)

1. Download or build the `.vsix` file
2. In VS Code: Extensions → `...` menu → "Install from VSIX..."
3. Select the `quad-terminal-0.0.1.vsix` file

### Build from Source

```bash
git clone https://github.com/beks-m/vscode-quad-terminal.git
cd vscode-quad-terminal
npm install
npx @electron/rebuild -f -w node-pty -v 32.0.0
npm run package
```

## Usage

1. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Run **"Quad Terminal: Open"**
3. The terminal grid appears in the panel area
4. Select a project from the dropdown in each terminal header
5. Claude CLI starts automatically in the selected project directory

### Controls

| Button | Action |
|--------|--------|
| Project dropdown | Select workspace folder |
| Resume checkbox | Resume previous Claude session |
| Expand icon | Toggle fullscreen for terminal |
| Trash icon | Kill the running process |

### Status Indicator

- **Gray** - Terminal inactive
- **Green** - Claude is idle/waiting for input
- **Yellow (pulsing)** - Claude is processing

## Requirements

- VS Code 1.85.0 or higher
- [Claude CLI](https://github.com/anthropics/claude-code) installed and available in PATH

## Commands

| Command | Description |
|---------|-------------|
| `Quad Terminal: Open` | Open the Quad Terminal panel |
| `Quad Terminal: Refresh` | Reset all terminals |

## Development

1. Clone the repository
2. Run `npm install`
3. Run `npx @electron/rebuild -f -w node-pty -v 32.0.0`
4. Open in VS Code and press `F5` to launch Extension Development Host

## Technical Details

- Uses [node-pty](https://github.com/microsoft/node-pty) for real PTY support
- Uses [xterm.js](https://xtermjs.org/) for terminal rendering
- Webview-based UI with VS Code theme integration

## License

MIT
