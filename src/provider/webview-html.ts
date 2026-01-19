import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Generate HTML content for the webview by loading template, CSS, and JS files
 */
export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  // Get paths to webview resources (in out/ directory after build)
  const webviewPath = path.join(extensionUri.fsPath, 'out', 'webview');

  // Read template, CSS, and JS files
  const htmlTemplate = fs.readFileSync(
    path.join(webviewPath, 'index.html'),
    'utf-8'
  );
  const css = fs.readFileSync(
    path.join(webviewPath, 'styles', 'main.css'),
    'utf-8'
  );
  const js = fs.readFileSync(
    path.join(webviewPath, 'scripts', 'main.js'),
    'utf-8'
  );

  // Build the final HTML with inline CSS and JS
  const html = htmlTemplate
    .replace(/\{\{cspSource\}\}/g, webview.cspSource)
    .replace(
      '<link rel="stylesheet" href="{{styleUri}}">',
      `<style>\n${css}\n</style>`
    )
    .replace(
      '<script src="{{scriptUri}}"></script>',
      `<script>\n${js}\n</script>`
    );

  return html;
}
