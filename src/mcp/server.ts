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
import { ASTExtractor } from '../extractors/astExtractor.js';
import { SemanticSearchEngine } from '../semantic/searchEngine.js';
import { CallGraphAnalyzer } from '../graph/callGraph.js';
import { ImpactAnalyzer } from '../graph/impactAnalyzer.js';
import { GlobalIndexManager } from '../multi/globalIndex.js';
import { ContextPackGenerator } from '../context/contextPack.js';
import { PRReviewer } from '../enterprise/prReviewer.js';
import { OnboardingDocsGenerator } from '../enterprise/onboardingDocs.js';
import { RouteRegistryManager } from '../microservices/routeRegistry.js';
import { ContractDriftDetector } from '../microservices/contractDrift.js';
import { ModelValidator } from '../validator/modelValidator.js';
import { DocstringMiner } from '../miner/docstringMiner.js';
import { VulnerabilityScanner } from '../security/vulnerabilityScanner.js';
import { ExecutionFlowTracer } from '../flow/executionFlow.js';
import { DiffChecker } from '../review/diffChecker.js';
import { DuplicationScanner } from '../quality/duplicationScanner.js';
import { ArchitectureDiagramBuilder } from '../graph/architectureDiagram.js';

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
  // MCP Tools
  // ==========================================
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'trace_flow',
          description: 'Trace how a feature executes: finds entry points (pages, route handlers, CLI commands) and follows real call sites and fetch-to-route-handler links, each with file:line evidence. Returns pathFound=false with related files instead of inventing a path.',
          inputSchema: {
            type: 'object',
            properties: {
              feature: {
                type: 'string',
                description: 'Feature or architectural query (e.g., E2EE encryption flow, user login, BM25 search).',
              },
            },
            required: ['feature'],
          },
        },
        {
          name: 'get_context_pack',
          description: 'Generate pre-digested zero-overhead AI context pack with optional token budget (--max-tokens) and AST skeletonization.',
          inputSchema: {
            type: 'object',
            properties: {
              task: {
                type: 'string',
                description: 'Task or feature description.',
              },
              max_tokens: {
                type: 'number',
                description: 'Maximum token budget (e.g., 2000). Compresses source snippets into AST skeletons if budget is tight.',
              },
            },
            required: ['task'],
          },
        },
        {
          name: 'impact_analysis',
          description: 'Analyze downstream breaking change impacts when modifying a file, route, or symbol before editing code.',
          inputSchema: {
            type: 'object',
            properties: {
              target: {
                type: 'string',
                description: 'File path, route, or symbol name being modified.',
              },
            },
            required: ['target'],
          },
        },
        {
          name: 'detect_api_drift',
          description: 'Detect client-to-server API contract drift, payload key mismatches, query parameter drift, and orphan routes.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_codebase_conventions',
          description: 'Fetch conventions learned from this codebase (naming per symbol kind, export style, typing, docs, git norms) with the counts behind each value under `evidence`, plus role counts and top directories. Rules marked source: default ship with the tool and were not learned.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'scan_security_vulnerabilities',
          description: 'Perform static security scan for hardcoded API keys, JWT secrets, unsafe eval/exec, and SQL injection risks.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_tech_debt_items',
          description: 'Fetch mined TODO, FIXME, HACK, and DEPRECATED technical debt markers across codebase.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_model_health_status',
          description: 'Check model health confidence score (0-100%), AST coverage, and trigger self-correction.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_microservice_api_routes',
          description: 'Extract exposed HTTP/REST API endpoints and consumed routes across microservices.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'search_codebase',
          description: 'Perform hybrid semantic/keyword search across indexed code chunks and symbols. Each result is labelled code, doc or config; docs rank below code.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Semantic query describing code behavior, conventions, or rules.',
              },
              include_conventions: {
                type: 'boolean',
                description: 'Also return the learned conventions block (off by default; use get_codebase_conventions instead).',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'search_global_workspace',
          description: 'Perform cross-repository semantic vector search across all workspace projects.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Cross-repo semantic search query.',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'generate_pr_review',
          description: 'Generate a Markdown PR review of the working tree diff (same checks as check_diff_against_standards), listing findings with file:line, the checks run, and what still needs human review.',
          inputSchema: {
            type: 'object',
            properties: {
              base: {
                type: 'string',
                description: 'Optional git ref to compare against instead of HEAD (e.g. main).',
              },
            },
          },
        },
        {
          name: 'generate_onboarding_guide',
          description: 'Generate developer onboarding manual (.codebase/ONBOARDING.md) summarizing codebase architecture and conventions.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'check_diff_against_standards',
          description: 'Check a git diff (by default the working tree against HEAD, including untracked files) for hardcoded secrets, security risks, removed exports still imported elsewhere, API contract drift, and convention violations. Every finding has a file and line. Also lists what it does not check: a pass is not a full review.',
          inputSchema: {
            type: 'object',
            properties: {
              diff: {
                type: 'string',
                description: 'Optional unified diff (output of `git diff`). Omit to read the working tree. Prose or code snippets are rejected.',
              },
              base: {
                type: 'string',
                description: 'Optional git ref to compare the working tree against instead of HEAD (e.g. main).',
              },
            },
          },
        },
        {
          name: 'analyze_codebase_quality',
          description: 'Analyze call graph, circular import dependencies, and performance/quality bottlenecks.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'visualize_architecture',
          description: 'Module-level dependency diagram (Mermaid) built from resolved imports: which directories import which, how many imports each arrow stands for, and module import cycles.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'scan_code_duplication',
          description: 'Find exact duplicated code blocks (whitespace-insensitive, at least min_lines significant lines) across code files, with every copy\'s file and line range.',
          inputSchema: {
            type: 'object',
            properties: {
              min_lines: {
                type: 'number',
                description: 'Smallest duplicated block to report, in significant lines (default 6).',
              },
              include_tests: {
                type: 'boolean',
                description: 'Also scan test files (default false).',
              },
            },
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const repoPath = resolveRepoPath(args?.repoPath ? String(args.repoPath) : undefined);

    // Standardized & Aliased: trace_flow / trace_execution_flow
    if (name === 'trace_flow' || name === 'trace_execution_flow') {
      const feature = String(args?.feature || '');
      const flow = ExecutionFlowTracer.traceFlow(repoPath, feature);
      // steps and summaryFlow restate the edges for humans; agents get the edges once
      const { steps, summaryFlow, ...compactFlow } = flow;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(compactFlow, null, 2),
          },
        ],
      };
    }

    // Standardized & Aliased: get_context_pack / get_agent_context_pack
    if (name === 'get_context_pack' || name === 'get_agent_context_pack') {
      const task = String(args?.task || '');
      const maxTokens = args?.max_tokens ? Number(args.max_tokens) : undefined;
      const pack = ContextPackGenerator.generateContextPack(repoPath, task, maxTokens);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(pack, null, 2),
          },
        ],
      };
    }

    // Standardized & Aliased: impact_analysis / get_change_impact_analysis
    if (name === 'impact_analysis' || name === 'get_change_impact_analysis') {
      const target = String(args?.target || '');
      const result = ImpactAnalyzer.analyzeImpact(repoPath, target);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    // New: detect_api_drift
    if (name === 'detect_api_drift') {
      const report = ContractDriftDetector.detectDrift(repoPath);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    }

    if (name === 'get_codebase_conventions') {
      // The search index builds itself on first search, so only conventions need generating here
      const conventions = ConventionMiner.loadOrGenerate(repoPath);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(conventions, null, 2),
          },
        ],
      };
    }

    if (name === 'scan_security_vulnerabilities') {
      const findings = VulnerabilityScanner.scanCodebase(repoPath);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(findings, null, 2),
          },
        ],
      };
    }

    if (name === 'get_tech_debt_items') {
      const facts = ASTExtractor.scanDirectory(repoPath);
      const items = DocstringMiner.mineTechDebtAndDocs(repoPath, facts);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(items, null, 2),
          },
        ],
      };
    }

    if (name === 'get_model_health_status') {
      const health = ModelValidator.validateAndSelfCorrect(repoPath);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(health, null, 2),
          },
        ],
      };
    }

    if (name === 'get_microservice_api_routes') {
      const registry = RouteRegistryManager.extractServiceRoutes(repoPath);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(registry, null, 2),
          },
        ],
      };
    }

    if (name === 'generate_pr_review') {
      const report = PRReviewer.reviewPR(repoPath, undefined, args?.base ? String(args.base) : undefined);
      return {
        content: [
          {
            type: 'text',
            text: report.summaryMarkdown,
          },
        ],
      };
    }

    if (name === 'generate_onboarding_guide') {
      const guidePath = OnboardingDocsGenerator.generateOnboardingGuide(repoPath);
      return {
        content: [
          {
            type: 'text',
            text: `Generated onboarding guide at ${guidePath}`,
          },
        ],
      };
    }

    if (name === 'search_codebase') {
      const query = String(args?.query || '');
      const { results: searchHits, index } = SemanticSearchEngine.searchWithStatus(repoPath, query, 5);
      const response: Record<string, unknown> = {
        semanticResults: SemanticSearchEngine.compactResults(repoPath, query, searchHits),
        index: {
          builtAt: index.builtAt,
          refreshedAt: index.refreshedAt,
          fullRebuild: index.fullRebuild,
          refreshedFiles: index.refreshedFiles.length,
          removedFiles: index.removedFiles.length,
          ...(index.staleFiles.length > 0 && {
            staleFiles: index.staleFiles.slice(0, 20),
            warning: `${index.staleFiles.length} file(s) changed since indexing and were not refreshed; results marked stale may be out of date.`,
          }),
          ...(index.error && { error: index.error }),
        },
      };
      if (args?.include_conventions === true) {
        response.conventions = ConventionMiner.loadConventions(repoPath);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    }

    if (name === 'search_global_workspace') {
      const query = String(args?.query || '');
      const parentDir = args?.parentDir ? String(args.parentDir) : path.dirname(repoPath);
      const searchHits = GlobalIndexManager.globalSearch(parentDir, query, 10);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ globalResults: searchHits }, null, 2),
          },
        ],
      };
    }

    if (name === 'analyze_codebase_quality') {
      const graph = CallGraphAnalyzer.analyzeGraph(repoPath);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(graph, null, 2),
          },
        ],
      };
    }

    if (name === 'check_diff_against_standards') {
      const report = DiffChecker.check(repoPath, {
        diff: args?.diff !== undefined ? String(args.diff) : undefined,
        base: args?.base ? String(args.base) : undefined,
      });

      return {
        isError: report.status === 'invalid-input',
        content: [
          {
            type: 'text',
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    }

    if (name === 'visualize_architecture') {
      const diagram = ArchitectureDiagramBuilder.build(repoPath);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(diagram, null, 2),
          },
        ],
      };
    }

    if (name === 'scan_code_duplication') {
      const report = DuplicationScanner.scan(repoPath, {
        minLines: args?.min_lines ? Number(args.min_lines) : undefined,
        includeTests: args?.include_tests === true,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    }

    throw new Error(`Tool not found: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
