import * as path from 'path';
import { ConventionMiner } from '../miner/conventionMiner.js';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { SemanticSearchEngine } from '../semantic/searchEngine.js';
import { CallGraphAnalyzer } from '../graph/callGraph.js';
import { ImpactAnalyzer } from '../graph/impactAnalyzer.js';
import { GlobalIndexManager } from '../multi/globalIndex.js';
import { ContextPackGenerator } from '../context/contextPack.js';
import { FeatureSliceBuilder } from '../context/featureSlice.js';
import { PRReviewer } from '../enterprise/prReviewer.js';
import { OnboardingDocsGenerator } from '../enterprise/onboardingDocs.js';
import { RouteRegistryManager } from '../microservices/routeRegistry.js';
import { ContractDriftDetector } from '../microservices/contractDrift.js';
import { ModelValidator } from '../validator/modelValidator.js';
import { DocstringMiner } from '../miner/docstringMiner.js';
import { VulnerabilityScanner } from '../security/vulnerabilityScanner.js';
import { PermissionMapBuilder } from '../security/permissionMap.js';
import { ExecutionFlowTracer } from '../flow/executionFlow.js';
import { DiffChecker } from '../review/diffChecker.js';
import { DuplicationScanner } from '../quality/duplicationScanner.js';
import { ArchitectureDiagramBuilder } from '../graph/architectureDiagram.js';
import { SarifExporter } from '../ci/sarifExporter.js';
import { ProjectConfigLoader } from '../config/projectConfig.js';
import { DEFAULT_TOOL_BUDGET, fitToBudget } from './budget.js';

/**
 * The MCP tool surface: eight tools, each covering one job an agent has. Every tool takes `budget_tokens` and
 * reports `budget.tokens` used plus anything it cut. The 1.x tool names still work as deprecated aliases.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  // The MCP result type is open-ended
  [key: string]: unknown;
}

type Args = Record<string, unknown>;

const budgetProperty = { type: 'number', description: 'Maximum size of the result in tokens (default 8000, or budgets.defaultTokens in codebase-trainer.yaml). Longer lists are cut from the end and listed under budget.omitted.' };

export const TOOLS: ToolDefinition[] = [
  {
    name: 'search',
    description: 'Find code by words, a question, or a symbol name. Returns ranked snippets labelled code, test, doc or config (code ranks first), with file:line. Lexical (BM25, symbols, PageRank), plus a local neural model when the repo opted in. scope=workspace searches every repo under the parent folder.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to find, e.g. "where are API keys revoked" or "resolveImport".' },
        scope: { type: 'string', enum: ['repo', 'workspace'], description: 'repo (default) or workspace (all indexed repos under the parent folder).' },
        limit: { type: 'number', description: 'Number of results (default 5).' },
        detail: { type: 'string', enum: ['refs', 'snippets'], description: 'refs: file:line only (cheapest); snippets (default): the matching lines.' },
        include_conventions: { type: 'boolean', description: 'Also return the learned conventions (off by default; codebase_overview has them).' },
        budget_tokens: budgetProperty,
      },
      required: ['query'],
    },
  },
  {
    name: 'feature_slice',
    description: 'Everything an agent needs to change one feature, across layers (UI -> client -> route -> service -> data model), within a token budget: files by layer with why each was included, the flows between them, and signatures/snippets packed to the budget. Use before changing a feature that spans several files.',
    inputSchema: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'Feature in plain words (e.g. "article comments", "subscription billing").' },
        budget_tokens: { type: 'number', description: 'Token budget for the packed slice (default 6000).' },
        include_tests: { type: 'boolean', description: 'Also include test files (default false).' },
        include_docs: { type: 'boolean', description: 'Also include documentation files (default false).' },
      },
      required: ['feature'],
    },
  },
  {
    name: 'trace_flow',
    description: 'Trace how a feature executes: entry points (pages, route handlers, CLI commands), then real call sites, fetch-to-route links and data-layer calls in order, each with file:line evidence. Returns pathFound=false with related files instead of inventing a path.',
    inputSchema: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'Feature or flow, e.g. "user login" or "checkout".' },
        budget_tokens: budgetProperty,
      },
      required: ['feature'],
    },
  },
  {
    name: 'impact',
    description: 'Before changing a file or symbol: the files that import it (directly and transitively), other references, and the tests to run with a ready-to-run command per test runner.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'File path or symbol name being changed.' },
        budget_tokens: budgetProperty,
      },
      required: ['target'],
    },
  },
  {
    name: 'review_diff',
    description: 'Check a git diff (default: working tree against HEAD, including untracked files) for secrets, security risks, removed exports still imported, API contract drift, permission mismatches on changed routes, and convention violations; every finding has file:line. Lists the tests to run and what it does not check: a pass is not a full review.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'A unified diff (output of `git diff`). Omit to read the working tree.' },
        base: { type: 'string', description: 'Git ref to compare against instead of HEAD (e.g. main).' },
        format: { type: 'string', enum: ['json', 'markdown', 'sarif'], description: 'json (default), markdown (a PR review comment) or sarif (code scanning).' },
        budget_tokens: budgetProperty,
      },
    },
  },
  {
    name: 'api_map',
    description: 'The HTTP API: routes the repo serves and calls, client/server contract drift (method, path and payload mismatches), and the permission map (auth, scopes and roles per route, with heuristic findings).',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['all', 'routes', 'drift', 'permissions'], description: 'Which part (default all; permissions there are summary and findings only).' },
        budget_tokens: budgetProperty,
      },
    },
  },
  {
    name: 'codebase_overview',
    description: 'How this codebase is built: learned conventions with the evidence behind each, the module dependency diagram (Mermaid) with import cycles, quality hotspots, and index health. section=onboarding writes an onboarding guide.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['all', 'conventions', 'architecture', 'quality', 'health', 'onboarding'], description: 'Which part (default all, without onboarding).' },
        budget_tokens: budgetProperty,
      },
    },
  },
  {
    name: 'quality_scan',
    description: 'Static scans with file:line: security (hardcoded secrets, eval/exec, SQL built from strings), duplicated code blocks, tech-debt markers (TODO/FIXME/HACK) and circular imports.',
    inputSchema: {
      type: 'object',
      properties: {
        checks: { type: 'array', items: { type: 'string', enum: ['security', 'duplication', 'debt', 'cycles'] }, description: 'Which scans (default all).' },
        min_lines: { type: 'number', description: 'Smallest duplicated block, in significant lines (default 6).' },
        include_tests: { type: 'boolean', description: 'Also scan test files for duplication (default false).' },
        budget_tokens: budgetProperty,
      },
    },
  },
];

// 1.x names -> the 2.0 tool and arguments that replace them
export const LEGACY_TOOLS: Record<string, (args: Args) => { tool: string; args: Args; legacy?: true }> = {
  search_codebase: args => ({ tool: 'search', args }),
  search_global_workspace: args => ({ tool: 'search', args: { ...args, scope: 'workspace' } }),
  trace_execution_flow: args => ({ tool: 'trace_flow', args }),
  impact_analysis: args => ({ tool: 'impact', args }),
  get_change_impact_analysis: args => ({ tool: 'impact', args }),
  check_diff_against_standards: args => ({ tool: 'review_diff', args }),
  generate_pr_review: args => ({ tool: 'review_diff', args: { ...args, format: 'markdown' } }),
  get_microservice_api_routes: args => ({ tool: 'api_map', args: { ...args, section: 'routes' } }),
  detect_api_drift: args => ({ tool: 'api_map', args: { ...args, section: 'drift' } }),
  get_permission_map: args => ({ tool: 'api_map', args: { ...args, section: 'permissions' } }),
  get_codebase_conventions: args => ({ tool: 'codebase_overview', args: { ...args, section: 'conventions' } }),
  visualize_architecture: args => ({ tool: 'codebase_overview', args: { ...args, section: 'architecture' } }),
  analyze_codebase_quality: args => ({ tool: 'codebase_overview', args: { ...args, section: 'quality' } }),
  get_model_health_status: args => ({ tool: 'codebase_overview', args: { ...args, section: 'health' } }),
  generate_onboarding_guide: args => ({ tool: 'codebase_overview', args: { ...args, section: 'onboarding' } }),
  scan_security_vulnerabilities: args => ({ tool: 'quality_scan', args: { ...args, checks: ['security'] } }),
  scan_code_duplication: args => ({ tool: 'quality_scan', args: { ...args, checks: ['duplication'] } }),
  get_tech_debt_items: args => ({ tool: 'quality_scan', args: { ...args, checks: ['debt'] } }),
  // Superseded by feature_slice, but kept with its own output for existing prompts
  get_context_pack: args => ({ tool: 'get_context_pack', args, legacy: true }),
  get_agent_context_pack: args => ({ tool: 'get_context_pack', args, legacy: true }),
};

const warnedLegacy = new Set<string>();

/**
 * Runs a tool (2.0 name or 1.x alias) and returns MCP content. Errors in arguments come back as isError results.
 */
export async function callTool(repoPath: string, name: string, args: Args = {}): Promise<ToolResult> {
  const legacy = LEGACY_TOOLS[name];
  if (legacy && !warnedLegacy.has(name)) {
    warnedLegacy.add(name);
    const replacement = legacy(args);
    // stdout carries the protocol; stderr is the server log
    if (!replacement.legacy) console.error(`[codebase-trainer] Tool \`${name}\` is deprecated; use \`${replacement.tool}\`. It keeps working through 2.x.`);
  }
  const { tool, args: toolArgs } = legacy ? legacy(args) : { tool: name, args };
  const config = ProjectConfigLoader.load(repoPath);
  const budget = Number(toolArgs.budget_tokens) > 0 ? Number(toolArgs.budget_tokens) : config.budgets.defaultTokens ?? DEFAULT_TOOL_BUDGET;
  const text = (value: unknown) => JSON.stringify(value, null, 2);
  const json = (value: unknown): ToolResult => {
    const fitted = fitToBudget(value, budget);
    const result = fitted.value && typeof fitted.value === 'object' && !Array.isArray(fitted.value)
      ? { ...(fitted.value as object), budget: fitted.budget }
      : { result: fitted.value, budget: fitted.budget };
    return { content: [{ type: 'text', text: text(result) }] };
  };

  switch (tool) {
    case 'search': {
      const query = String(toolArgs.query || '');
      const limit = Number(toolArgs.limit) > 0 ? Number(toolArgs.limit) : 5;
      if (toolArgs.scope === 'workspace') {
        const parentDir = toolArgs.parentDir ? String(toolArgs.parentDir) : path.dirname(repoPath);
        return json({ globalResults: GlobalIndexManager.globalSearch(parentDir, query, Math.max(limit, 10)) });
      }
      const { results, index, neural, neuralSkipped } = await SemanticSearchEngine.searchWithStatusAsync(repoPath, query, limit);
      const compact = SemanticSearchEngine.compactResults(repoPath, query, results);
      const response: Record<string, unknown> = {
        semanticResults: toolArgs.detail === 'refs'
          ? compact.map(({ snippet, ...ref }) => ref)
          : compact,
        mode: neural ? `lexical + neural (${neural.model})` : 'lexical',
        ...(neuralSkipped && { neuralSkipped }),
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
      if (toolArgs.include_conventions === true) response.conventions = ConventionMiner.loadConventions(repoPath);
      return json(response);
    }

    case 'feature_slice': {
      // The slice packs itself to its budget; it does not go through the generic cut
      const sliceBudget = Number(toolArgs.budget_tokens) > 0 ? Number(toolArgs.budget_tokens) : config.budgets.featureSliceTokens;
      const slice = FeatureSliceBuilder.build(repoPath, String(toolArgs.feature || ''), {
        budgetTokens: sliceBudget,
        includeTests: Boolean(toolArgs.include_tests),
        includeDocs: Boolean(toolArgs.include_docs),
      });
      return { content: [{ type: 'text', text: text(slice) }] };
    }

    case 'trace_flow': {
      const flow = ExecutionFlowTracer.traceFlow(repoPath, String(toolArgs.feature || ''));
      // steps and summaryFlow restate the edges for humans; agents get the edges once
      const { steps, summaryFlow, ...compactFlow } = flow;
      return json(compactFlow);
    }

    case 'impact':
      return json(ImpactAnalyzer.analyzeImpact(repoPath, String(toolArgs.target || '')));

    case 'review_diff': {
      const options = {
        diff: toolArgs.diff !== undefined ? String(toolArgs.diff) : undefined,
        base: toolArgs.base ? String(toolArgs.base) : undefined,
      };
      if (toolArgs.format === 'markdown') {
        return { content: [{ type: 'text', text: PRReviewer.reviewPR(repoPath, options.diff, options.base).summaryMarkdown }] };
      }
      const report = DiffChecker.check(repoPath, options);
      if (toolArgs.format === 'sarif') {
        return { isError: report.status === 'invalid-input', content: [{ type: 'text', text: text(SarifExporter.fromDiffReport(report)) }] };
      }
      return { ...json(report), isError: report.status === 'invalid-input' };
    }

    case 'api_map': {
      const section = String(toolArgs.section || 'all');
      if (section === 'permissions') {
        const map = PermissionMapBuilder.build(repoPath);
        return json(toolArgs.findings_only ? { summary: map.summary, findings: map.findings, notes: map.notes } : map);
      }
      if (section === 'drift') return json(ContractDriftDetector.detectDrift(repoPath));
      const registry = RouteRegistryManager.extractServiceRoutes(repoPath);
      const { summary, findings } = PermissionMapBuilder.build(repoPath);
      const permissions = { summary, findings, detail: 'api_map with section=permissions lists every route with its guards.' };
      if (section === 'routes') return json({ ...registry, permissions });
      return json({ routes: registry, drift: ContractDriftDetector.detectDrift(repoPath), permissions });
    }

    case 'codebase_overview': {
      const section = String(toolArgs.section || 'all');
      if (section === 'onboarding') {
        return { content: [{ type: 'text', text: `Generated onboarding guide at ${OnboardingDocsGenerator.generateOnboardingGuide(repoPath)}` }] };
      }
      const parts: Record<string, unknown> = {};
      if (section === 'all' || section === 'conventions') parts.conventions = ConventionMiner.loadOrGenerate(repoPath);
      if (section === 'all' || section === 'architecture') parts.architecture = ArchitectureDiagramBuilder.build(repoPath);
      if (section === 'quality') parts.quality = CallGraphAnalyzer.analyzeGraph(repoPath);
      if (section === 'all') parts.qualityIssues = CallGraphAnalyzer.analyzeGraph(repoPath).qualityIssues;
      if (section === 'all' || section === 'health') parts.health = ModelValidator.validateAndSelfCorrect(repoPath);
      if (config.warnings.length > 0) parts.configWarnings = config.warnings;
      return json(section === 'all' ? parts : parts[section] ?? parts);
    }

    case 'quality_scan': {
      const checks = Array.isArray(toolArgs.checks) && toolArgs.checks.length > 0 ? toolArgs.checks.map(String) : ['security', 'duplication', 'debt', 'cycles'];
      const parts: Record<string, unknown> = {};
      if (checks.includes('security')) parts.security = VulnerabilityScanner.scanCodebase(repoPath);
      if (checks.includes('duplication')) {
        parts.duplication = DuplicationScanner.scan(repoPath, {
          minLines: Number(toolArgs.min_lines) > 0 ? Number(toolArgs.min_lines) : undefined,
          includeTests: toolArgs.include_tests === true,
        });
      }
      if (checks.includes('debt')) parts.debt = DocstringMiner.mineTechDebtAndDocs(repoPath, ASTExtractor.scanDirectory(repoPath));
      if (checks.includes('cycles')) parts.cycles = CallGraphAnalyzer.analyzeGraph(repoPath).qualityIssues.filter(q => q.type === 'circular_dependency');
      return json(checks.length === 1 ? parts[checks[0]] : parts);
    }

    case 'get_context_pack': {
      const maxTokens = toolArgs.max_tokens ? Number(toolArgs.max_tokens) : undefined;
      return { content: [{ type: 'text', text: text(ContextPackGenerator.generateContextPack(repoPath, String(toolArgs.task || ''), maxTokens)) }] };
    }
  }

  return { isError: true, content: [{ type: 'text', text: `Unknown tool \`${name}\`. Tools: ${TOOLS.map(t => t.name).join(', ')}.` }] };
}
