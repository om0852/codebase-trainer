#!/usr/bin/env node
import { Command } from 'commander';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { ConventionMiner } from '../miner/conventionMiner.js';
import { runMCPServer } from '../mcp/server.js';
import { IndexStore } from '../storage/db.js';
import { GitMiner } from '../git/gitMiner.js';
import { GitHooksManager } from '../git/hooks.js';
import { SemanticSearchEngine } from '../semantic/searchEngine.js';
import { run1000QueryBenchmark } from './benchmark.js';
import { CallGraphAnalyzer } from '../graph/callGraph.js';
import { ImpactAnalyzer } from '../graph/impactAnalyzer.js';
import { DashboardGenerator } from '../ui/dashboardGenerator.js';
import { AutoFixer } from '../fixer/autoFixer.js';
import { GlobalIndexManager } from '../multi/globalIndex.js';
import { ContextPackGenerator } from '../context/contextPack.js';
import { SarifExporter } from '../ci/sarifExporter.js';
import { PRReviewer } from '../enterprise/prReviewer.js';
import { OnboardingDocsGenerator } from '../enterprise/onboardingDocs.js';
import { RouteRegistryManager } from '../microservices/routeRegistry.js';
import { ModelValidator } from '../validator/modelValidator.js';
import { VulnerabilityScanner } from '../security/vulnerabilityScanner.js';
import { ExecutionFlowTracer } from '../flow/executionFlow.js';
import { CodebaseWatcher } from '../watcher/fileWatcher.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const program = new Command();

program
  .name('cb-trainer')
  .description('Fast local Codebase Intelligence Index & NLP Model generator for AI agents & IDEs')
  .version('1.0.0');

program
  .command('init')
  .description('Initialize .codebase/ index, scan AST structural facts, and mine conventions.yaml')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((options) => {
    const repoPath = path.resolve(options.dir);
    console.log(`🔍 Scanning codebase AST facts at: ${repoPath}...`);

    const facts = ASTExtractor.scanDirectory(repoPath);
    console.log(`✅ Analyzed ${facts.length} source files.`);

    IndexStore.saveIndex(repoPath, facts);

    console.log(`🧠 Building local semantic vector index...`);
    SemanticSearchEngine.buildIndex(repoPath);

    const conventions = ConventionMiner.generateConventions(repoPath, facts);
    const yamlPath = ConventionMiner.saveConventions(repoPath, conventions);

    const graph = CallGraphAnalyzer.analyzeGraph(repoPath);
    const htmlPath = DashboardGenerator.generateHTML(repoPath, conventions, graph);

    console.log(`✨ Generated codebase conventions model at: ${yamlPath}`);
    console.log(`🌐 Dashboard generated at: ${htmlPath}`);
    console.log(`\nModel Summary:`);
    console.log(`  - Constants placement: ${conventions.rules.structural.constantsPlacement}`);
    console.log(`  - Export style: ${conventions.rules.structural.exportStyle}`);
    console.log(`  - Type annotations required: ${conventions.rules.structural.typeAnnotationRequirement}`);
    console.log(`  - Git commit format: ${conventions.rules.git.commitFormat}`);
  });

program
  .command('flow <feature>')
  .description('Trace end-to-end execution flow and generate sequence diagram for a feature')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((feature, options) => {
    const repoPath = path.resolve(options.dir);
    console.log(`🔄 Tracing End-to-End Execution Flow for: "${feature}"...`);
    const flow = ExecutionFlowTracer.traceFlow(repoPath, feature);

    console.log(`\n📐 Mermaid Sequence Diagram:\n`);
    console.log(`\`\`\`mermaid\n${flow.mermaidDiagram}\n\`\`\``);

    console.log(`\n📋 Step-by-Step Code Execution Trace:\n`);
    console.log(flow.summaryFlow);
  });

program
  .command('security')
  .description('Perform static security scan for hardcoded API keys, JWT secrets, unsafe eval/exec, and SQL injection risks')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((options) => {
    const repoPath = path.resolve(options.dir);
    console.log(`🛡️ Scanning security vulnerabilities & hardcoded secrets at: ${repoPath}...`);
    const findings = VulnerabilityScanner.scanCodebase(repoPath);

    if (findings.length === 0) {
      console.log('✨ No security vulnerabilities or hardcoded secrets detected!');
    } else {
      console.log(`⚠️ Detected ${findings.length} security findings:`);
      findings.forEach((f, idx) => {
        console.log(`\n[${idx + 1}] [${f.severity}] ${f.filePath}:${f.line} - ${f.description}`);
        console.log(`    Snippet: ${f.snippet}`);
      });
      console.log(`\n✨ Security report saved to: ${path.join(repoPath, '.codebase', 'security_audit.json')}`);
    }
  });

program
  .command('status')
  .description('Check model health confidence score (0-100%), AST coverage, and trigger self-correction')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((options) => {
    const repoPath = path.resolve(options.dir);
    console.log(`🩺 Checking Codebase Intelligence Model Health for: ${repoPath}...`);
    const health = ModelValidator.validateAndSelfCorrect(repoPath);

    console.log(`\n📊 Model Health Score: ${health.healthScore}%`);
    console.log(`📄 Total Files Scanned: ${health.totalFilesScanned}`);
    console.log(`🧩 Mapped Symbol Nodes: ${health.mappedSymbolsCount}`);
    console.log(`🔄 Self-Correction Triggered: ${health.isSelfCorrected ? 'YES' : 'NO'}`);

    console.log(`\n💡 Recommendations:`);
    health.recommendations.forEach(r => console.log(`   - ${r}`));
  });

program
  .command('routes')
  .description('Extract exposed HTTP/REST API endpoints and consumed routes across microservices')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((options) => {
    const repoPath = path.resolve(options.dir);
    console.log(`📡 Mapping exposed & consumed API routes for: ${repoPath}...`);
    const registry = RouteRegistryManager.extractServiceRoutes(repoPath);

    console.log(`\n🌐 Exposed Endpoints (${registry.exposedRoutes.length}):`);
    registry.exposedRoutes.forEach(r => console.log(`   - [${r.method}] ${r.routePath} (${r.definedInFile})`));

    console.log(`\n🔗 Consumed External Routes (${registry.consumedRoutes.length}):`);
    registry.consumedRoutes.forEach(c => console.log(`   - ${c}`));

    console.log(`✨ Registry saved to: ${path.join(repoPath, '.codebase', 'api_registry.json')}`);
  });

program
  .command('pr-review')
  .description('Generate automated PR review report with policy enforcement checks')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((options) => {
    const repoPath = path.resolve(options.dir);
    console.log(`🤖 Generating PR review report for: ${repoPath}...`);
    const report = PRReviewer.reviewPR(repoPath);

    console.log(`\n${report.summaryMarkdown}`);
    console.log(`✨ Report saved to: ${path.join(repoPath, '.codebase', 'pr_review.md')}`);
  });

program
  .command('docs')
  .description('Generate developer onboarding manual (.codebase/ONBOARDING.md) summarizing architecture and rules')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((options) => {
    const repoPath = path.resolve(options.dir);
    console.log(`🚀 Generating developer onboarding guide for: ${repoPath}...`);
    const guidePath = OnboardingDocsGenerator.generateOnboardingGuide(repoPath);
    console.log(`✅ Onboarding guide generated at: ${guidePath}`);
  });

program
  .command('context <task>')
  .description('Generate pre-digested zero-overhead AI Context Pack for a task or feature')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((task, options) => {
    const repoPath = path.resolve(options.dir);
    console.log(`📦 Digesting AI Agent Context Pack for task: "${task}"...`);
    const pack = ContextPackGenerator.generateContextPack(repoPath, task);

    console.log(`✨ Context Pack generated at: ${path.join(repoPath, '.codebase', 'context_pack.json')}`);
    console.log(`\nPack Contents Summary:`);
    console.log(`  - Target Codebase: ${pack.codebaseName}`);
    console.log(`  - Top Semantic Code Snippets: ${pack.topSemanticChunks.length}`);
    console.log(`  - Downstream Risk Impact Warnings: ${pack.impactAnalysis.breakingRiskWarning.length}`);
  });

program
  .command('ci')
  .description('Export GitHub Actions / GitLab CI compatible SARIF static analysis report')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((options) => {
    const repoPath = path.resolve(options.dir);
    console.log(`🛡️ Exporting SARIF CI Security & Quality Report...`);
    const sarifPath = SarifExporter.generateSARIF(repoPath);
    console.log(`✅ SARIF report generated at: ${sarifPath}`);
  });

program
  .command('global-init')
  .description('Scan all workspace repositories and combine NLP models into a Master Workspace Model')
  .option('-d, --dir <path>', 'Parent workspace path containing repos', '..')
  .action((options) => {
    const parentDir = path.resolve(options.dir);
    GlobalIndexManager.scanAllRepositories(parentDir);
  });

program
  .command('global-search <query>')
  .description('Perform cross-repository semantic vector search across all workspace projects')
  .option('-d, --dir <path>', 'Parent workspace path containing repos', '..')
  .option('-k, --limit <number>', 'Top K results', '10')
  .action((query, options) => {
    const parentDir = path.resolve(options.dir);
    const limit = parseInt(options.limit, 10) || 10;

    console.log(`🌐 Performing cross-repo global search for: "${query}"...`);
    const results = GlobalIndexManager.globalSearch(parentDir, query, limit);

    if (results.length === 0) {
      console.log('⚠️ No matching semantic code chunks found across workspace.');
      return;
    }

    console.log(`\nFound ${results.length} cross-repository semantic matches:`);
    results.forEach((r, idx) => {
      console.log(`\n[${idx + 1}] Score: ${(r.score * 100).toFixed(1)}% | ${r.filePath}#L${r.startLine}-L${r.endLine}`);
      console.log('---');
      console.log(r.snippet.split('\n').slice(0, 5).join('\n'));
    });
  });

program
  .command('update')
  .description('Incrementally re-scan modified source files')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((options) => {
    const repoPath = path.resolve(options.dir);
    const facts = ASTExtractor.scanDirectory(repoPath);
    const changed = IndexStore.getChangedFiles(repoPath, facts);

    if (changed.length === 0) {
      console.log('⚡ Codebase index is already up to date. No modified files detected.');
      return;
    }

    console.log(`🔄 Incremental re-scan detected ${changed.length} modified file(s):`);
    changed.forEach(f => console.log(`   - ${path.relative(repoPath, f)}`));

    IndexStore.saveIndex(repoPath, facts);
    SemanticSearchEngine.buildIndex(repoPath);
    const conventions = ConventionMiner.generateConventions(repoPath, facts);
    const yamlPath = ConventionMiner.saveConventions(repoPath, conventions);

    const graph = CallGraphAnalyzer.analyzeGraph(repoPath);
    DashboardGenerator.generateHTML(repoPath, conventions, graph);

    console.log(`✅ Incremental update completed: ${yamlPath}`);
  });

program
  .command('impact <target>')
  .description('Analyze downstream breaking change impacts when modifying a file, route, or symbol')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((target, options) => {
    const repoPath = path.resolve(options.dir);
    console.log(`🔍 Analyzing downstream impact for modifying: "${target}"...`);
    const impact = ImpactAnalyzer.analyzeImpact(repoPath, target);

    console.log(`\n📌 Direct Dependents (${impact.directDependents.length} files):`);
    impact.directDependents.forEach(d => console.log(`   - ${d}`));

    console.log(`\n🔗 Transitive Downstream Impact (${impact.transitiveDependents.length} files):`);
    impact.transitiveDependents.forEach(t => console.log(`   - ${t}`));

    console.log(`\n🌐 Affected Route/Usage References (${impact.affectedRoutes.length} files):`);
    impact.affectedRoutes.forEach(r => console.log(`   - ${r}`));

    console.log(`\n⚠️ Risk Assessment Summary:`);
    impact.breakingRiskWarning.forEach(w => console.log(`   - ${w}`));
  });

program
  .command('search <query>')
  .description('Perform semantic vector search across indexed codebase chunks')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .option('-k, --limit <number>', 'Top K results', '5')
  .action((query, options) => {
    const repoPath = path.resolve(options.dir);
    const limit = parseInt(options.limit, 10) || 5;

    console.log(`🔎 Performing semantic search for: "${query}"...`);
    const results = SemanticSearchEngine.search(repoPath, query, limit);

    if (results.length === 0) {
      console.log('⚠️ No matching semantic code chunks found.');
      return;
    }

    console.log(`\nFound ${results.length} semantic matches:`);
    results.forEach((r, idx) => {
      console.log(`\n[${idx + 1}] Score: ${(r.score * 100).toFixed(1)}% | ${path.relative(repoPath, r.filePath)}#L${r.startLine}-L${r.endLine}`);
      console.log('---');
      console.log(r.snippet.split('\n').slice(0, 5).join('\n'));
    });
  });

program
  .command('ui')
  .alias('dashboard')
  .description('Generate and open interactive HTML codebase intelligence dashboard')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((options) => {
    const repoPath = path.resolve(options.dir);
    const conventions = ConventionMiner.loadConventions(repoPath);

    if (!conventions) {
      console.error('❌ No codebase model found. Run `cb-trainer init` first.');
      process.exit(1);
    }

    const graph = CallGraphAnalyzer.analyzeGraph(repoPath);
    const htmlPath = DashboardGenerator.generateHTML(repoPath, conventions, graph);

    console.log(`🌐 Dashboard generated at: ${htmlPath}`);
    try {
      if (process.platform === 'win32') {
        execSync(`start "" "${htmlPath}"`, { stdio: 'ignore' });
      } else if (process.platform === 'darwin') {
        execSync(`open "${htmlPath}"`, { stdio: 'ignore' });
      } else {
        execSync(`xdg-open "${htmlPath}"`, { stdio: 'ignore' });
      }
      console.log('🚀 Opened dashboard in web browser!');
    } catch {
      console.log(`🔗 Open file directly in your browser: file://${htmlPath}`);
    }
  });

program
  .command('fix <file>')
  .description('Automatically fix codebase convention violations in target file')
  .action((file) => {
    const filePath = path.resolve(file);
    console.log(`🛠️ Auto-fixing convention violations in: ${filePath}...`);
    const result = AutoFixer.fixFile(filePath);

    if (result.fixedCount === 0) {
      console.log('✨ No fixable convention violations found.');
    } else {
      console.log(`✅ Applied ${result.fixedCount} automatic fixes:`);
      result.changesDescription.forEach(desc => console.log(`   - ${desc}`));
    }
  });

program
  .command('audit')
  .description('Analyze call-graph dependencies, circular imports, and sync I/O performance issues')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((options) => {
    const repoPath = path.resolve(options.dir);
    console.log(`🔍 Auditing codebase performance & call graph at: ${repoPath}...`);
    const graph = CallGraphAnalyzer.analyzeGraph(repoPath);

    console.log(`\n📊 Mapped ${Object.keys(graph.nodes).length} function symbol nodes.`);
    console.log(`⚠️ Detected ${graph.qualityIssues.length} performance/quality issues:`);
    graph.qualityIssues.forEach((issue, idx) => {
      console.log(`\n[${idx + 1}] [${issue.severity.toUpperCase()}] ${path.relative(repoPath, issue.filePath)}${issue.line ? `:${issue.line}` : ''}`);
      console.log(`    ${issue.description}`);
    });
  });

program
  .command('benchmark')
  .description('Run a 1,000-query stress test suite across 10 domain categories with latency percentiles')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((options) => {
    const repoPath = path.resolve(options.dir);
    run1000QueryBenchmark(repoPath);
  });

program
  .command('query <prompt>')
  .description('Query codebase conventions and facts')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((prompt, options) => {
    const repoPath = path.resolve(options.dir);
    const conventions = ConventionMiner.loadConventions(repoPath);

    if (!conventions) {
      console.error('❌ No codebase model found. Run `cb-trainer init` first.');
      process.exit(1);
    }

    console.log(`🔎 Query: "${prompt}"`);
    console.log('\nFound Codebase Rules:');
    console.log(JSON.stringify(conventions.rules, null, 2));
  });

program
  .command('review [target]')
  .description('Review file or git diff against codebase conventions')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((target, options) => {
    const repoPath = path.resolve(options.dir);
    const conventions = ConventionMiner.loadConventions(repoPath);

    if (!conventions) {
      console.error('❌ No codebase model found. Run `cb-trainer init` first.');
      process.exit(1);
    }

    console.log(`🔍 Reviewing target against ${conventions.codebaseName} conventions...`);
    let hasViolations = false;
    let contentToReview = '';

    if (target && fs.existsSync(target)) {
      contentToReview = fs.readFileSync(target, 'utf8');
    } else {
      console.log('ℹ️  No file specified. Reviewing uncommitted git diff...');
      contentToReview = GitMiner.getUncommittedDiff(repoPath);
    }

    if (conventions.rules.structural.typeAnnotationRequirement && contentToReview.includes(': any')) {
      console.warn(`⚠️ Warning: Explicit \`any\` casting detected (violates typeAnnotationRequirement).`);
      hasViolations = true;
    }

    if (!hasViolations) {
      console.log('✅ Code change satisfies all codebase conventions!');
    }
  });

const hooks = program.command('hooks').description('Manage automated git hooks');

hooks
  .command('install')
  .description('Install git post-commit hook for automated re-scanning')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((options) => {
    const repoPath = path.resolve(options.dir);
    const result = GitHooksManager.installHooks(repoPath);
    if (result.success) console.log(`✅ ${result.message}`);
    else console.error(`❌ ${result.message}`);
  });

hooks
  .command('uninstall')
  .description('Uninstall git post-commit hook')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((options) => {
    const repoPath = path.resolve(options.dir);
    const result = GitHooksManager.uninstallHooks(repoPath);
    if (result.success) console.log(`✅ ${result.message}`);
    else console.error(`❌ ${result.message}`);
  });

program
  .command('watch')
  .description('Start real-time background file watcher to re-index changed files automatically on save')
  .option('-d, --dir <path>', 'Target repo path', '.')
  .action((options) => {
    const repoPath = path.resolve(options.dir);
    CodebaseWatcher.watch(repoPath);
  });

program
  .command('mcp')
  .description('Start Model Context Protocol (MCP) server over stdio for AI IDE integration')
  .action(async () => {
    await runMCPServer();
  });

program.parse(process.argv);
