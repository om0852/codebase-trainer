import * as fs from 'fs';
import * as path from 'path';
import { ConventionMiner } from '../miner/conventionMiner.js';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { CallGraphAnalyzer } from '../graph/callGraph.js';

export class OnboardingDocsGenerator {
  public static generateOnboardingGuide(repoPath: string): string {
    const conventions = ConventionMiner.loadConventions(repoPath);
    const facts = ASTExtractor.scanDirectory(repoPath);
    const graph = CallGraphAnalyzer.analyzeGraph(repoPath);

    const repoName = conventions?.codebaseName || path.basename(repoPath);

    const guideMarkdown = `# 🚀 Onboarding Guide: ${repoName}

Welcome to **${repoName}**! This documentation was generated automatically by **Codebase Trainer**.

---

## 🏗️ Architecture & Stack Overview
- **Total Source Files**: ${facts.length}
- **Primary Languages**: ${Array.from(new Set(facts.map(f => f.language))).join(', ')}
- **Mapped Functions**: ${Object.keys(graph.nodes).length} Symbol Nodes

---

## 📐 Project Conventions Cheat Sheet
- **Constants Placement**: Defined at **${conventions?.rules.structural.constantsPlacement.toUpperCase()}** of files.
- **Export Style**: Prefer **${conventions?.rules.structural.exportStyle.toUpperCase()}** exports.
- **Strict Typing**: ${conventions?.rules.structural.typeAnnotationRequirement ? 'Required' : 'Optional'}.
- **Git Commit Format**: \`${conventions?.rules.git.commitFormat}\`.

---

## ⚡ Key Modules & Entrypoints
${facts.slice(0, 10).map(f => `- \`${path.relative(repoPath, f.filePath)}\` (${f.language}, ${f.funcCount} functions)`).join('\n')}

---

## 💡 Quick Start Command
\`\`\`bash
npx cb-trainer query "conventions"
npx cb-trainer review
\`\`\`
`;

    const outPath = path.join(repoPath, '.codebase', 'ONBOARDING.md');
    fs.writeFileSync(outPath, guideMarkdown, 'utf8');
    return outPath;
  }
}
