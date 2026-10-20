import * as fs from 'fs';
import * as path from 'path';
import { ASTExtractor } from '../extractors/astExtractor.js';

export interface ClientCall {
  method: string;
  endpoint: string;
  filePath: string;
  line: number;
  payloadKeys: string[];
  queryKeys: string[];
}

export interface ServerEndpoint {
  method: string;
  endpoint: string;
  filePath: string;
  line: number;
  expectedBodyKeys: string[];
  expectedQueryKeys: string[];
}

export interface ContractDriftIssue {
  type: 'payload_mismatch' | 'missing_field' | 'dead_endpoint' | 'orphan_endpoint' | 'method_mismatch';
  severity: 'error' | 'warning' | 'info';
  endpoint: string;
  method: string;
  clientFile?: string;
  clientLine?: number;
  serverFile?: string;
  serverLine?: number;
  description: string;
  clientPayloadFields?: string[];
  serverExpectedFields?: string[];
  suggestedFix?: string;
}

export interface DriftReport {
  scannedClientCalls: number;
  scannedServerEndpoints: number;
  issues: ContractDriftIssue[];
  healthStatus: 'HEALTHY' | 'DRIFT_DETECTED' | 'CRITICAL_MISMATCH';
}

export class ContractDriftDetector {
  /**
   * Scans codebase for frontend fetch/axios calls and extracts endpoints, methods, and payload shapes.
   */
  public static extractClientCalls(repoPath: string): ClientCall[] {
    const facts = ASTExtractor.scanDirectory(repoPath);
    const calls: ClientCall[] = [];

    facts.forEach(fact => {
      if (!fs.existsSync(fact.filePath)) return;
      let content = '';
      try {
        content = fs.readFileSync(fact.filePath, 'utf8');
      } catch {
        return;
      }

      const lines = content.split(/\r?\n/);
      const relPath = path.relative(repoPath, fact.filePath);

      lines.forEach((line, idx) => {
        const lineNum = idx + 1;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

        // 1. fetch('/api/...')
        const fetchMatch = line.match(/fetch\s*\(\s*['"`]([^'"`]+)['"`](?:,\s*(\{[^}]*\}|[\w]+))?/);
        if (fetchMatch) {
          const endpoint = fetchMatch[1];
          if (endpoint.includes('...')) return;
          if (endpoint.startsWith('/') || endpoint.includes('api')) {
            const contextBlock = lines.slice(idx, Math.min(lines.length, idx + 12)).join(' ');
            
            // Extract method
            const methodMatch = contextBlock.match(/method\s*:\s*['"`](GET|POST|PUT|DELETE|PATCH)['"`]/i);
            const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';

            // Extract body keys
            const payloadKeys = this.extractKeysFromBody(contextBlock);
            const queryKeys = this.extractQueryKeys(endpoint);

            calls.push({
              method,
              endpoint: endpoint.split('?')[0],
              filePath: relPath,
              line: lineNum,
              payloadKeys,
              queryKeys
            });
          }
        }

        // 2. axios.post('/api/...', { ... }) / axios.get(...)
        const axiosMatch = line.match(/axios\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/i);
        if (axiosMatch) {
          const method = axiosMatch[1].toUpperCase();
          const endpoint = axiosMatch[2];
          const contextBlock = lines.slice(idx, Math.min(lines.length, idx + 10)).join(' ');
          const payloadKeys = method !== 'GET' ? this.extractKeysFromBody(contextBlock) : [];
          const queryKeys = this.extractQueryKeys(endpoint);

          calls.push({
            method,
            endpoint: endpoint.split('?')[0],
            filePath: relPath,
            line: lineNum,
            payloadKeys,
            queryKeys
          });
        }
      });
    });

    return calls;
  }

  /**
   * Scans codebase for backend route definitions and expected payload / query parameters.
   */
  public static extractServerEndpoints(repoPath: string): ServerEndpoint[] {
    const facts = ASTExtractor.scanDirectory(repoPath);
    const endpoints: ServerEndpoint[] = [];

    facts.forEach(fact => {
      if (!fs.existsSync(fact.filePath)) return;
      let content = '';
      try {
        content = fs.readFileSync(fact.filePath, 'utf8');
      } catch {
        return;
      }

      const lines = content.split(/\r?\n/);
      const relPath = path.relative(repoPath, fact.filePath);

      lines.forEach((line, idx) => {
        const lineNum = idx + 1;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

        // Express / Fastify style: app.post('/api/domains', ...) or router.get(...)
        const routeMatch = line.match(/(?:app|router|server)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/i);
        if (routeMatch) {
          const method = routeMatch[1].toUpperCase();
          const routePath = routeMatch[2];
          if (routePath.includes('...')) return;
          const handlerBlock = lines.slice(idx, Math.min(lines.length, idx + 35)).join('\n');

          const expectedBodyKeys = this.extractExpectedBodyKeys(handlerBlock);
          const expectedQueryKeys = this.extractExpectedQueryKeys(handlerBlock);

          endpoints.push({
            method,
            endpoint: routePath,
            filePath: relPath,
            line: lineNum,
            expectedBodyKeys,
            expectedQueryKeys
          });
        }

        // Next.js App Router style: export async function POST(req) { const { ... } = await req.json() }
        const nextMatch = line.match(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)\s*\(/i);
        if (nextMatch) {
          const normRel = relPath.replace(/\\/g, '/');
          if (!normRel.includes('api/') && !normRel.includes('routes/')) return;

          const method = nextMatch[1].toUpperCase();
          // Infer endpoint from folder path e.g., app/api/v1/domains/route.ts -> /api/v1/domains
          let endpoint = normRel;
          if (endpoint.includes('api/')) {
            endpoint = '/' + endpoint.substring(endpoint.indexOf('api/'));
            endpoint = endpoint.replace(/\/route\.(ts|js|mjs)/, '').replace(/\.(ts|js|mjs)/, '');
          }

          const handlerBlock = lines.slice(idx, Math.min(lines.length, idx + 35)).join('\n');
          const expectedBodyKeys = this.extractExpectedBodyKeys(handlerBlock);
          const expectedQueryKeys = this.extractExpectedQueryKeys(handlerBlock);

          endpoints.push({
            method,
            endpoint,
            filePath: relPath,
            line: lineNum,
            expectedBodyKeys,
            expectedQueryKeys
          });
        }
      });
    });

    return endpoints;
  }

  /**
   * Compares client calls and server endpoints to detect schema drift, field mismatches, and dead endpoints.
   */
  public static detectDrift(repoPath: string): DriftReport {
    const clientCalls = this.extractClientCalls(repoPath);
    const serverEndpoints = this.extractServerEndpoints(repoPath);
    const issues: ContractDriftIssue[] = [];

    // Map server endpoints by normalized path + method
    const serverMap = new Map<string, ServerEndpoint>();
    serverEndpoints.forEach(ep => {
      const key = `${ep.method}:${this.normalizePath(ep.endpoint)}`;
      serverMap.set(key, ep);
    });

    const accessedServerKeys = new Set<string>();

    // 1. Analyze every client call against server endpoints
    clientCalls.forEach(call => {
      const normPath = this.normalizePath(call.endpoint);
      const exactKey = `${call.method}:${normPath}`;

      // Check if endpoint exists with different HTTP method
      const matchedEndpointAnyMethod = serverEndpoints.find(
        ep => this.normalizePath(ep.endpoint) === normPath
      );

      if (matchedEndpointAnyMethod && matchedEndpointAnyMethod.method !== call.method) {
        issues.push({
          type: 'method_mismatch',
          severity: 'error',
          endpoint: call.endpoint,
          method: call.method,
          clientFile: call.filePath,
          clientLine: call.line,
          serverFile: matchedEndpointAnyMethod.filePath,
          serverLine: matchedEndpointAnyMethod.line,
          description: `Client invokes [${call.method}] ${call.endpoint}, but server endpoint only accepts [${matchedEndpointAnyMethod.method}].`,
          suggestedFix: `Update client call in ${call.filePath}:${call.line} to use HTTP method ${matchedEndpointAnyMethod.method}.`
        });
        return;
      }

      const serverEp = serverMap.get(exactKey);

      if (!serverEp) {
        // Could be a dead endpoint or external API
        if (call.endpoint.startsWith('/api') || call.endpoint.startsWith('/v1') || call.endpoint.startsWith('/v2')) {
          issues.push({
            type: 'dead_endpoint',
            severity: 'error',
            endpoint: call.endpoint,
            method: call.method,
            clientFile: call.filePath,
            clientLine: call.line,
            description: `Client calls [${call.method}] \`${call.endpoint}\`, but no matching backend route handler exists.`,
            suggestedFix: `Verify route definition or register [${call.method}] ${call.endpoint} in backend API router.`
          });
        }
        return;
      }

      accessedServerKeys.add(exactKey);

      // 2. Validate Body / Payload Fields
      if (serverEp.expectedBodyKeys.length > 0 && call.payloadKeys.length > 0) {
        // Check for missing expected keys
        const missingOnClient = serverEp.expectedBodyKeys.filter(
          k => !call.payloadKeys.includes(k)
        );

        // Check for payload keys that do not match server expectations
        const extraOnClient = call.payloadKeys.filter(
          k => !serverEp.expectedBodyKeys.includes(k)
        );

        if (missingOnClient.length > 0 && extraOnClient.length > 0) {
          // Possible field rename / drift (e.g. client sends `hostname`, server expects `domain`)
          issues.push({
            type: 'payload_mismatch',
            severity: 'error',
            endpoint: call.endpoint,
            method: call.method,
            clientFile: call.filePath,
            clientLine: call.line,
            serverFile: serverEp.filePath,
            serverLine: serverEp.line,
            clientPayloadFields: call.payloadKeys,
            serverExpectedFields: serverEp.expectedBodyKeys,
            description: `API Contract Payload Drift: Client sends [${extraOnClient.join(', ')}] but backend route expects [${missingOnClient.join(', ')}].`,
            suggestedFix: `Synchronize payload fields: Align client \`${extraOnClient[0]}\` with backend \`${missingOnClient[0]}\`.`
          });
        } else if (missingOnClient.length > 0) {
          issues.push({
            type: 'missing_field',
            severity: 'warning',
            endpoint: call.endpoint,
            method: call.method,
            clientFile: call.filePath,
            clientLine: call.line,
            serverFile: serverEp.filePath,
            serverLine: serverEp.line,
            clientPayloadFields: call.payloadKeys,
            serverExpectedFields: serverEp.expectedBodyKeys,
            description: `Client payload is missing expected field(s): [${missingOnClient.join(', ')}].`,
            suggestedFix: `Pass [${missingOnClient.join(', ')}] in request body.`
          });
        }
      }
    });

    // 3. Scan for Orphan Routes (Routes defined on server, but unconsumed across codebase)
    serverEndpoints.forEach(ep => {
      const key = `${ep.method}:${this.normalizePath(ep.endpoint)}`;
      if (!accessedServerKeys.has(key)) {
        issues.push({
          type: 'orphan_endpoint',
          severity: 'info',
          endpoint: ep.endpoint,
          method: ep.method,
          serverFile: ep.filePath,
          serverLine: ep.line,
          description: `Orphan Endpoint: [${ep.method}] \`${ep.endpoint}\` is exposed but has 0 internal client consumers.`,
          suggestedFix: `If route is deprecated, consider archiving or adding automated test coverage.`
        });
      }
    });

    const hasErrors = issues.some(i => i.severity === 'error');
    const hasWarnings = issues.some(i => i.severity === 'warning');

    const healthStatus: DriftReport['healthStatus'] = hasErrors
      ? 'CRITICAL_MISMATCH'
      : hasWarnings
      ? 'DRIFT_DETECTED'
      : 'HEALTHY';

    // Save report to .codebase/contract_drift.json
    const outDir = path.join(repoPath, '.codebase');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'contract_drift.json'),
      JSON.stringify({ clientCalls, serverEndpoints, issues, healthStatus }, null, 2),
      'utf8'
    );

    return {
      scannedClientCalls: clientCalls.length,
      scannedServerEndpoints: serverEndpoints.length,
      issues,
      healthStatus
    };
  }

  // --- Helper Parsers ---

  private static normalizePath(p: string): string {
    return p.toLowerCase()
      .replace(/\/+/g, '/')
      .replace(/\/$/, '')
      .replace(/:\w+/g, '{id}')
      .replace(/\[\w+\]/g, '{id}');
  }

  private static extractKeysFromBody(block: string): string[] {
    const keys: string[] = [];
    // e.g. JSON.stringify({ hostname, isCustom, userId: id })
    const bodyMatch = block.match(/(?:body\s*:\s*JSON\.stringify\s*\(\s*\{|post\s*\([^,]+,\s*\{)([^}]+)\}/);
    if (bodyMatch) {
      const inner = bodyMatch[1];
      inner.split(',').forEach(part => {
        const key = part.split(':')[0].trim().replace(/['"`]/g, '');
        if (/^[a-zA-Z0-9_$]+$/.test(key) && !['method', 'headers', 'mode', 'body'].includes(key)) {
          keys.push(key);
        }
      });
    }
    return keys;
  }

  private static extractQueryKeys(endpoint: string): string[] {
    if (!endpoint.includes('?')) return [];
    const queryPart = endpoint.split('?')[1];
    return queryPart.split('&').map(pair => pair.split('=')[0].trim()).filter(Boolean);
  }

  private static extractExpectedBodyKeys(block: string): string[] {
    const keys = new Set<string>();
    
    // const { a, b } = req.body / const { a, b } = await req.json()
    const destructureMatch = block.match(/(?:const|let|var)\s+\{([^}]+)\}\s*=\s*(?:req\.body|await\s+req\.json\(\)|request\.body)/);
    if (destructureMatch) {
      destructureMatch[1].split(',').forEach(k => {
        const clean = k.split(':')[0].split('=')[0].trim();
        if (/^[a-zA-Z0-9_$]+$/.test(clean)) keys.add(clean);
      });
    }

    // req.body.x
    const dotMatches = block.matchAll(/req\.body\.([a-zA-Z0-9_$]+)/g);
    for (const m of dotMatches) {
      if (m[1]) keys.add(m[1]);
    }

    return Array.from(keys);
  }

  private static extractExpectedQueryKeys(block: string): string[] {
    const keys = new Set<string>();
    const destructureMatch = block.match(/(?:const|let|var)\s+\{([^}]+)\}\s*=\s*req\.query/);
    if (destructureMatch) {
      destructureMatch[1].split(',').forEach(k => {
        const clean = k.split(':')[0].trim();
        if (/^[a-zA-Z0-9_$]+$/.test(clean)) keys.add(clean);
      });
    }
    const dotMatches = block.matchAll(/req\.query\.([a-zA-Z0-9_$]+)/g);
    for (const m of dotMatches) {
      if (m[1]) keys.add(m[1]);
    }
    return Array.from(keys);
  }
}
