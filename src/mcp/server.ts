import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { ConventionMiner } from '../miner/conventionMiner.js';
import { CallGraphAnalyzer } from '../graph/callGraph.js';
import { RouteRegistryManager } from '../microservices/routeRegistry.js';
import { ContractDriftDetector } from '../microservices/contractDrift.js';
import { PermissionMapBuilder } from '../security/permissionMap.js';
import { TOOLS, callTool } from './tools.js';

export async function runMCPServer(initialRepoPath: string = process.cwd()) {
  function resolveRepoPath(customPath?: string): string {
    if (customPath && fs.existsSync(customPath)) return path.resolve(customPath);
    if (fs.existsSync(path.join(initialRepoPath, '.codebase'))) return path.resolve(initialRepoPath);
    if (fs.existsSync(path.join(process.cwd(), '.codebase'))) return path.resolve(process.cwd());
    return path.resolve(initialRepoPath || process.cwd());
  }

  const server = new Server(
    {
      name: 'codebase-trainer-mcp',
      version: '1.4.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // ==========================================
  // MCP Resources (Live dynamic context feeds)
  // ==========================================
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: 'codebase://conventions',
          name: 'Codebase Conventions & Architecture Rules',
          description: 'Dynamic structural rules, export patterns, and naming conventions mined for this project.',
          mimeType: 'application/json',
        },
        {
          uri: 'codebase://routes',
          name: 'Microservice API Routes Map',
          description: 'Live map of all exposed HTTP endpoints and consumed external service routes.',
          mimeType: 'application/json',
        },
        {
          uri: 'codebase://graph/circular',
          name: 'Circular Dependency Warnings',
          description: 'Real-time circular import dependencies and architecture bottleneck alerts.',
          mimeType: 'application/json',
        },
        {
          uri: 'codebase://graph/quality',
          name: 'Call Graph Quality & Sync I/O Alerts',
          description: 'Detected synchronous I/O in loops, high-complexity functions, and dead code warnings.',
          mimeType: 'application/json',
        },
        {
          uri: 'codebase://permissions',
          name: 'Route Permission Map',
          description: 'Every route with its auth requirement, scopes and roles (with evidence), plus heuristic permission findings.',
          mimeType: 'application/json',
        },
        {
          uri: 'codebase://drift',
          name: 'Client-to-Server API Contract Drift Report',
          description: 'Live payload drift, field mismatches, and orphan endpoint warnings between client and backend.',
          mimeType: 'application/json',
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const repoPath = resolveRepoPath();

    if (uri === 'codebase://conventions') {
      const conventions = ConventionMiner.loadOrGenerate(repoPath);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(conventions, null, 2),
          },
        ],
      };
    }

    if (uri === 'codebase://routes') {
      const registry = RouteRegistryManager.extractServiceRoutes(repoPath);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(registry, null, 2),
          },
        ],
      };
    }

    if (uri === 'codebase://graph/circular') {
      const graph = CallGraphAnalyzer.analyzeGraph(repoPath);
      const circularIssues = graph.qualityIssues.filter(q => q.type === 'circular_dependency');
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(circularIssues, null, 2),
          },
        ],
      };
    }

    if (uri === 'codebase://graph/quality') {
      const graph = CallGraphAnalyzer.analyzeGraph(repoPath);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(graph.qualityIssues, null, 2),
          },
        ],
      };
    }

    if (uri === 'codebase://permissions') {
      const map = PermissionMapBuilder.build(repoPath);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(map, null, 2),
          },
        ],
      };
    }

    if (uri === 'codebase://drift') {
      const report = ContractDriftDetector.detectDrift(repoPath);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    }

    throw new Error(`Resource not found: ${uri}`);
  });

  // ==========================================
  // MCP Tools (src/mcp/tools.ts): eight tools; 1.x names remain callable as aliases
  // ==========================================
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const repoPath = resolveRepoPath(args?.repoPath ? String(args.repoPath) : undefined);
    return callTool(repoPath, name, (args ?? {}) as Record<string, unknown>);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
