import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * `cb-trainer setup`: registers the MCP server with the AI clients in use. Project-level config files
 * (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`) are written in the repo so the team shares them;
 * Windsurf only has a per-user file, which is written only when asked for by name.
 */

export type ClientId = 'claude' | 'cursor' | 'vscode' | 'windsurf';

export interface SetupAction {
  client: ClientId;
  file: string;
  status: 'written' | 'updated' | 'unchanged' | 'skipped' | 'would-write';
  detail?: string;
}

const SERVER_NAME = 'codebase-trainer';
const COMMAND = { command: 'npx', args: ['-y', 'codebase-trainer', 'mcp'] };

interface ClientSpec {
  label: string;
  // Config file, relative to the repo (or absolute for per-user files)
  file: (repoPath: string) => string;
  // Where servers live in that file, and the entry for ours
  key: string;
  entry: Record<string, unknown>;
  detect: (repoPath: string) => boolean;
  perUser?: boolean;
}

const onPath = (bin: string) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export const CLIENTS: Record<ClientId, ClientSpec> = {
  claude: {
    label: 'Claude Code',
    file: repo => path.join(repo, '.mcp.json'),
    key: 'mcpServers',
    entry: { ...COMMAND },
    detect: repo => fs.existsSync(path.join(repo, '.mcp.json')) || fs.existsSync(path.join(os.homedir(), '.claude')) || onPath('claude'),
  },
  cursor: {
    label: 'Cursor',
    file: repo => path.join(repo, '.cursor', 'mcp.json'),
    key: 'mcpServers',
    entry: { ...COMMAND },
    detect: repo => fs.existsSync(path.join(repo, '.cursor')) || fs.existsSync(path.join(os.homedir(), '.cursor')),
  },
  vscode: {
    label: 'VS Code',
    file: repo => path.join(repo, '.vscode', 'mcp.json'),
    key: 'servers',
    entry: { type: 'stdio', ...COMMAND },
    detect: repo => fs.existsSync(path.join(repo, '.vscode')) || onPath('code'),
  },
  windsurf: {
    label: 'Windsurf (per-user config)',
    file: () => path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    key: 'mcpServers',
    entry: { ...COMMAND },
    detect: () => false,
    perUser: true,
  },
};

export class SetupWizard {
  /** Clients to configure: the ones named, or every project-level client that looks installed. */
  public static clientsFor(repoPath: string, requested?: string[]): ClientId[] {
    if (requested && requested.length > 0) {
      const ids = requested.flatMap(r => r === 'all' ? (Object.keys(CLIENTS) as ClientId[]).filter(id => !CLIENTS[id].perUser) : [r]);
      const unknown = ids.filter(id => !(id in CLIENTS));
      if (unknown.length > 0) throw new Error(`Unknown client(s): ${unknown.join(', ')}. Choose from ${Object.keys(CLIENTS).join(', ')}, all.`);
      return [...new Set(ids)] as ClientId[];
    }
    const detected = (Object.keys(CLIENTS) as ClientId[]).filter(id => CLIENTS[id].detect(repoPath));
    // Claude Code's project file is harmless for other clients and the most common target
    return detected.length > 0 ? detected : ['claude'];
  }

  /**
   * Adds the codebase-trainer server to each client's config, keeping every other server and setting in the file.
   */
  public static configure(repoPath: string, clients: ClientId[], dryRun = false): SetupAction[] {
    return clients.map(client => {
      const spec = CLIENTS[client];
      const file = spec.file(repoPath);
      const shown = spec.perUser ? file : path.relative(repoPath, file).replace(/\\/g, '/');
      let doc: Record<string, unknown> = {};
      const exists = fs.existsSync(file);
      if (exists) {
        try {
          const raw = fs.readFileSync(file, 'utf8');
          doc = raw.trim() ? JSON.parse(raw) : {};
        } catch {
          return { client, file: shown, status: 'skipped', detail: 'existing file is not valid JSON; left untouched' };
        }
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
          return { client, file: shown, status: 'skipped', detail: 'existing file is not a JSON object; left untouched' };
        }
      }
      const servers = (doc[spec.key] && typeof doc[spec.key] === 'object' ? doc[spec.key] : {}) as Record<string, unknown>;
      if (JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(spec.entry)) return { client, file: shown, status: 'unchanged' };
      if (dryRun) return { client, file: shown, status: 'would-write' };

      doc[spec.key] = { ...servers, [SERVER_NAME]: spec.entry };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      return { client, file: shown, status: exists ? 'updated' : 'written' };
    });
  }
}
