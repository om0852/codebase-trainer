import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
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
import { ModelValidator } from '../validator/modelValidator.js';
import { DocstringMiner } from '../miner/docstringMiner.js';
import { VulnerabilityScanner } from '../security/vulnerabilityScanner.js';
import { ExecutionFlowTracer } from '../flow/executionFlow.js';
import { ReviewResult } from '../types/index.js';

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
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'get_codebase_conventions',
          description: 'Fetch structural rules, conventions, git norms, and custom guidelines learned for this codebase.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'trace_execution_flow',
          description: 'Generate step-by-step execution flow and Mermaid sequence diagram for how a feature or architecture works.',
          inputSchema: {
            type: 'object',
            properties: {
              feature: {
                type: 'string',
                description: 'Feature or architectural query (e.g., E2EE encryption flow, user login).',
              },
            },
            required: ['feature'],
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
          name: 'get_agent_context_pack',
          description: 'Generate pre-digested zero-overhead AI context pack containing rules, impact warnings, and top semantic code snippets for a task.',
          inputSchema: {
            type: 'object',
            properties: {
              task: {
                type: 'string',
                description: 'Task or feature description.',
              },
            },
            required: ['task'],
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
          description: 'Perform semantic vector search across indexed code chunks, symbols, and conventions.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Semantic query describing code behavior, conventions, or rules.',
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
          description: 'Generate automated Markdown PR review report with policy enforcement checks.',
          inputSchema: {
            type: 'object',
            properties: {},
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
          description: 'Validate code changes or diff against learned codebase conventions.',
          inputSchema: {
            type: 'object',
            properties: {
              diff: {
                type: 'string',
                description: 'Code snippet or git diff string to review.',
              },
            },
            required: ['diff'],
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
          name: 'get_change_impact_analysis',
          description: 'Analyze downstream breaking change impacts when modifying a file, route, or symbol.',
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
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const repoPath = resolveRepoPath(args?.repoPath ? String(args.repoPath) : undefined);

    if (name === 'get_codebase_conventions') {
      let conventions = ConventionMiner.loadConventions(repoPath);
      if (!conventions) {
        // Auto-train and generate model on demand via MCP
        const facts = ASTExtractor.scanDirectory(repoPath);
        SemanticSearchEngine.buildIndex(repoPath);
        conventions = ConventionMiner.generateConventions(repoPath, facts);
        ConventionMiner.saveConventions(repoPath, conventions);
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(conventions, null, 2),
          },
        ],
      };
    }

    if (name === 'trace_execution_flow') {
      const feature = String(args?.feature || '');
      const flow = ExecutionFlowTracer.traceFlow(repoPath, feature);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(flow, null, 2),
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

    if (name === 'get_agent_context_pack') {
      const task = String(args?.task || '');
      const pack = ContextPackGenerator.generateContextPack(repoPath, task);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(pack, null, 2),
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
      const report = PRReviewer.reviewPR(repoPath);
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
      const conventions = ConventionMiner.loadConventions(repoPath);
      const searchHits = SemanticSearchEngine.search(repoPath, query, 5);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ conventions, semanticResults: searchHits }, null, 2),
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

    if (name === 'get_change_impact_analysis') {
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

    if (name === 'check_diff_against_standards') {
      const diffStr = String(args?.diff || '');
      const conventions = ConventionMiner.loadConventions(repoPath);

      const violations: ReviewResult['violations'] = [];
      if (conventions) {
        if (conventions.rules.structural.typeAnnotationRequirement && diffStr.includes(': any')) {
          violations.push({
            ruleId: 'no-explicit-any',
            message: 'Avoid explicit `any` type casting. Prefer typed interfaces or generics.',
            severity: 'warning'
          });
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ passed: violations.length === 0, violations }, null, 2),
          },
        ],
      };
    }

    throw new Error(`Tool not found: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
