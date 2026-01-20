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
