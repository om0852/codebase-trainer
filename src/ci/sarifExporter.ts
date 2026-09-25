import * as fs from 'fs';
import * as path from 'path';
import { CallGraphAnalyzer } from '../graph/callGraph.js';

export class SarifExporter {
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
