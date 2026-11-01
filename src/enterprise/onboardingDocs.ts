import * as fs from 'fs';
import * as path from 'path';
import { ConventionMiner } from '../miner/conventionMiner.js';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { CallGraphAnalyzer } from '../graph/callGraph.js';

export class OnboardingDocsGenerator {
  public static generateOnboardingGuide(repoPath: string): string {
    const facts = ASTExtractor.scanDirectory(repoPath);
    const conventions = ConventionMiner.loadOrGenerate(repoPath, facts);
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
${conventions ? `- **Naming**: ${conventions.rules.structural.namingConvention}.
- **Export Style**: ${conventions.rules.structural.exportStyle}${conventions.evidence?.['structural.exportStyle'] ? ` (${conventions.evidence['structural.exportStyle']})` : ''}.
- **Constants Placement**: ${conventions.rules.structural.constantsPlacement}${conventions.evidence?.['structural.constantsPlacement'] ? ` (${conventions.evidence['structural.constantsPlacement']})` : ''}.
- **Strict Typing**: ${conventions.rules.structural.typeAnnotationRequirement ? 'Required' : 'Optional'}${conventions.evidence?.['structural.typeAnnotationRequirement'] ? ` (${conventions.evidence['structural.typeAnnotationRequirement']})` : ''}.
- **Documentation**: ${conventions.rules.documentation.commentStyle}.
- **Git Commit Format**: \`${conventions.rules.git.commitFormat}\`; branches: ${conventions.rules.git.branchNaming}.` : '- Run `cb-trainer init` to learn this codebase\'s conventions.'}

---

## 🧭 Where Things Live
${conventions?.architecture ? Object.entries(conventions.architecture.roles)
  .sort((a, b) => b[1].count - a[1].count)
  .map(([role, r]) => `- **${role}** (${r.count}): ${r.examples.map(e => `\`${e}\``).join(', ')}`)
  .join('\n') : ''}

${conventions?.architecture ? `**Largest directories**: ${Object.entries(conventions.architecture.directories).slice(0, 8).map(([d, n]) => `\`${d}\` (${n})`).join(', ')}` : ''}

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

    const outDir = path.join(repoPath, '.codebase');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'ONBOARDING.md');
    fs.writeFileSync(outPath, guideMarkdown, 'utf8');
    return outPath;
  }
}
