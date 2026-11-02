import * as fs from 'fs';
import * as path from 'path';
import { CallGraphAnalyzer } from '../graph/callGraph.js';
import type { DiffCheckReport } from '../review/diffChecker.js';

export class SarifExporter {
  /**
   * SARIF 2.1.0 for a diff check (`cb-trainer review --format sarif`), for GitHub Code Scanning and other SARIF viewers.
   */
  public static fromDiffReport(report: DiffCheckReport): Record<string, unknown> {
    const version = (() => {
      try {
        return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string;
      } catch {
        return '0.0.0';
      }
    })();
    return {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'codebase-trainer',
              version,
              informationUri: 'https://www.npmjs.com/package/codebase-trainer',
              rules: report.checksRun.map(check => ({ id: check.id, shortDescription: { text: check.description } }))
            }
          },
          results: report.findings.map(f => ({
            ruleId: f.ruleId,
            level: f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'note',
            message: { text: f.message },
            locations: [{ physicalLocation: { artifactLocation: { uri: f.filePath }, region: { startLine: f.line || 1 } } }]
          }))
        }
      ]
    };
  }

  public static generateSARIF(repoPath: string): string {
    const graph = CallGraphAnalyzer.analyzeGraph(repoPath);

    const results = graph.qualityIssues.map(issue => ({
      ruleId: issue.type,
      level: issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'note',
      message: {
        text: issue.description
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: path.relative(repoPath, issue.filePath).replace(/\\/g, '/')
            },
            region: {
              startLine: issue.line || 1
            }
          }
        }
      ]
    }));

    const sarif = {
      $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'CodebaseTrainer',
              version: '1.0.0',
              informationUri: 'https://github.com/codebase-trainer'
            }
          },
          results
        }
      ]
    };

    const sarifPath = path.join(repoPath, '.codebase', 'results.sarif');
    fs.writeFileSync(sarifPath, JSON.stringify(sarif, null, 2), 'utf8');
    return sarifPath;
  }
}
