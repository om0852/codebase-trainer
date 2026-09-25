import { SemanticSearchEngine } from '../semantic/searchEngine.js';
import { ConventionMiner } from '../miner/conventionMiner.js';
import { CallGraphAnalyzer } from '../graph/callGraph.js';
import * as path from 'path';

// Generator for 1,000 queries spanning 10 domain sections
function generate1000Queries(): Array<{ text: string; category: string }> {
  const categories = [
    {
      name: "Bug Finding & Vulnerabilities",
      terms: ["uncaught exception", "null pointer dereference", "unhandled rejection", "memory leak listener", "buffer overflow", "dangling reference", "infinite loop recursion", "deprecated api call", "dangling promise", "type mismatch error"]
    },
    {
      name: "Performance & Hotpaths",
      terms: ["sync readFileSync hotpath", "blocking event loop", "heavy nested loop", "unindexed search scan", "expensive regex evaluation", "high memory allocation", "redundant object instantiation", "unthrottled scroll event", "heavy dom re-render", "uncached expensive computation"]
    },
    {
      name: "Security & Cryptography",
      terms: ["jwt token validation", "bcrypt password hash", "aes encryption key", "cors policy bypass", "csrf protection token", "sanitize xss input", "bearer authorization", "api secret key", "sql injection sanitize", "oauth2 token refresh"]
    },
    {
      name: "UI & Component Architecture",
      terms: ["modal overlay dialog", "button click event", "flexbox container layout", "dark mode toggle", "responsive grid view", "input form validation", "tooltip hover popup", "dropdown menu select", "toast notification banner", "card shadow elevation"]
    },
    {
      name: "Data Models & ORM",
      terms: ["prisma schema relation", "typeorm entity model", "user repository find", "transaction rollback commit", "foreign key constraint", "database index query", "crud create update delete", "mongodb aggregation pipeline", "cache invalidation redis", "blob storage bucket"]
    },
    {
      name: "API & Microservices",
      terms: ["express route handler", "axios interceptor request", "websocket connection stream", "grpc service definition", "rate limiter middleware", "status 500 server error", "request payload validation", "mcp tool request handler", "rest endpoint controller", "graphql query resolver"]
    },
    {
      name: "State & Design Patterns",
      terms: ["redux store dispatch", "react context provider", "useCallback memoization", "event emitter listener", "singleton instance get", "dependency injection container", "abstract class model", "factory pattern builder", "observer pattern pubsub", "command pattern execution"]
    },
    {
      name: "Call Graph & Dependencies",
      terms: ["circular import dependency", "module dependency graph", "function caller trace", "unused export function", "high cyclomatic complexity", "deep inheritance tree", "shared state mutation", "cross module coupling", "subsystem entrypoint", "global state reference"]
    },
    {
      name: "Testing & Automation",
      terms: ["jest mock implementation", "playwright e2e scenario", "test coverage report", "fixture data builder", "snapshot component test", "integration test suite", "stub function response", "spyOn method assertion", "regression test suite", "smoke test status"]
    },
    {
      name: "Diagnostics & Observability",
      terms: ["winston logger transport", "telemetry metric event", "performance timer latency", "health check endpoint", "audit trail logger", "structured json logging", "stack trace error log", "distributed tracing span", "monitoring alert trigger", "syslog daemon log"]
    }
  ];

  const result: Array<{ text: string; category: string }> = [];

  // Generate 100 queries per category = 1,000 total queries
  categories.forEach(cat => {
    for (let i = 0; i < 100; i++) {
      const termA = cat.terms[i % cat.terms.length];
      const termB = cat.terms[(i + 3) % cat.terms.length];
      const queryText = `${termA} ${termB} ${i % 2 === 0 ? 'pattern' : 'rule'}`;
      result.push({ text: queryText, category: cat.name });
    }
  });

  return result;
}

export function run1000QueryBenchmark(repoPath: string) {
  console.log(`🚀 Initializing 1,000-Query High-Scale Performance & Quality Audit Benchmark...`);
  console.log(`📁 Target Directory: ${repoPath}\n`);

  const conventions = ConventionMiner.loadConventions(repoPath);
  console.log(`📋 Target Codebase: ${conventions?.codebaseName || path.basename(repoPath)}`);
  console.log(`🔍 Analyzing Call-Graph & Architectural Dependencies...`);

  const graphStartTime = Date.now();
  const graph = CallGraphAnalyzer.analyzeGraph(repoPath);
  const graphDuration = Date.now() - graphStartTime;

  console.log(`✅ Call-Graph Analysis Complete in ${graphDuration} ms (${Object.keys(graph.nodes).length} function nodes mapped).`);
  console.log(`⚠️ Code Quality & Performance Warnings Detected: ${graph.qualityIssues.length}`);
  graph.qualityIssues.slice(0, 5).forEach(issue => {
    console.log(`   - [${issue.severity.toUpperCase()}] ${path.basename(issue.filePath)}: ${issue.description}`);
  });

  const queryList = generate1000Queries();
  console.log(`\n⚡ Executing 1,000 Queries Benchmark across 10 Domain Categories...`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  let totalMatches = 0;
  const latencies: number[] = [];
  const startSuiteTime = Date.now();

  queryList.forEach((q, idx) => {
    const qStart = Date.now();
    const results = SemanticSearchEngine.search(repoPath, q.text, 3);
    const elapsed = Date.now() - qStart;
    latencies.push(elapsed);
    totalMatches += results.length;

    if ((idx + 1) % 100 === 0) {
      console.log(`PROGRESS: Completed [${(idx + 1).toString().padStart(4, ' ')}/1000] queries | Last Category: "${q.category}"`);
    }
  });

  const totalSuiteDuration = (Date.now() - startSuiteTime) / 1000;
  latencies.sort((a, b) => a - b);

  const p50 = latencies[Math.floor(latencies.length * 0.50)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const qps = (1000 / totalSuiteDuration).toFixed(1);

  const memUsage = process.memoryUsage();
  const heapUsedMb = (memUsage.heapUsed / 1024 / 1024).toFixed(1);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🎉 1,000-QUERY HIGH-SCALE BENCHMARK RESULTS`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`⏱️  Total Time Elapsed: ${totalSuiteDuration.toFixed(2)} seconds`);
  console.log(`⚡ Throughput Rate:     ${qps} queries / second`);
  console.log(`📊 Total Matches Found: ${totalMatches}`);
  console.log(`📈 Latency Stats:`);
  console.log(`   - Average: ${avgLatency.toFixed(2)} ms`);
  console.log(`   - P50:     ${p50} ms`);
  console.log(`   - P95:     ${p95} ms`);
  console.log(`   - P99:     ${p99} ms`);
  console.log(`💾 Memory Overhead:    ${heapUsedMb} MB Heap Used`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}
