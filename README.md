# Quad Terminal

A VS Code extension that provides 4 terminals in a 2x2 grid layout.

## Features

- 4 terminals in a 2x2 grid
- Works in the sidebar or panel
- Each terminal is independent
- Resize-aware

## Installation

```bash
cd vscode-quad-terminal
npm install
npm run compile
```

## Development

1. Open this folder in VS Code
2. Press `F5` to launch the Extension Development Host
3. Open the Command Palette (`Cmd+Shift+P`) and run "Quad Terminal: Open"

## Usage

- Open Command Palette → "Quad Terminal: Open"
- Or find "Quad Terminal" in the sidebar

## Notes

This is a basic implementation. For full PTY support with real shell interaction, you would need to integrate `node-pty` which requires native compilation.

Current implementation uses VS Code's built-in pseudo-terminal API for basic echo functionality.
