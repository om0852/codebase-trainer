import * as fs from 'fs';
import * as path from 'path';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { ConventionMiner } from '../miner/conventionMiner.js';
import { IndexStore } from '../storage/db.js';
import { SemanticSearchEngine, CodeChunk, SearchResult } from '../semantic/searchEngine.js';

export interface GlobalWorkspaceModel {
  totalRepos: number;
  reposScanned: string[];
  totalFiles: number;
  totalChunks: number;
  combinedConventions: Record<string, any>;
  lastUpdated: string;
}

export class GlobalIndexManager {
  public static scanAllRepositories(parentDir: string): GlobalWorkspaceModel {
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    const repoPaths: string[] = [];

    entries.forEach(entry => {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const fullPath = path.join(parentDir, entry.name);
        repoPaths.push(fullPath);
      }
    });

    console.log(`🌐 Found ${repoPaths.length} workspace repositories in: ${parentDir}\n`);

    const allCombinedChunks: CodeChunk[] = [];
    const combinedConventions: Record<string, any> = {};
    let totalFiles = 0;
    const reposScanned: string[] = [];

    repoPaths.forEach((repoPath, idx) => {
      const repoName = path.basename(repoPath);
      console.log(`[${idx + 1}/${repoPaths.length}] 📦 Processing repository: ${repoName}...`);

      const facts = ASTExtractor.scanDirectory(repoPath);
      if (facts.length === 0) {
        console.log(`   - Skipped (no supported source files found).`);
        return;
      }

      totalFiles += facts.length;
      reposScanned.push(repoName);

      IndexStore.saveIndex(repoPath, facts);
      SemanticSearchEngine.buildIndex(repoPath);

      const conventions = ConventionMiner.generateConventions(repoPath, facts);
      ConventionMiner.saveConventions(repoPath, conventions);

      combinedConventions[repoName] = conventions.rules;

      // Collect chunks for global index
      const embeddingsPath = path.join(repoPath, '.codebase', 'embeddings.json');
      if (fs.existsSync(embeddingsPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(embeddingsPath, 'utf8'));
          if (data.chunks) {
            allCombinedChunks.push(...data.chunks);
          }
        } catch {}
      }

      console.log(`   - ✅ Scanned ${facts.length} files.`);
    });

    // Save Master Global Index in parent dir `.codebase`
    const globalCodebaseDir = path.join(parentDir, '.codebase');
    if (!fs.existsSync(globalCodebaseDir)) {
      fs.mkdirSync(globalCodebaseDir, { recursive: true });
    }

    const globalModel: GlobalWorkspaceModel = {
      totalRepos: reposScanned.length,
      reposScanned,
      totalFiles,
      totalChunks: allCombinedChunks.length,
      combinedConventions,
      lastUpdated: new Date().toISOString()
    };

    fs.writeFileSync(
      path.join(globalCodebaseDir, 'global_conventions.yaml'),
      JSON.stringify(globalModel, null, 2),
      'utf8'
    );

    fs.writeFileSync(
      path.join(globalCodebaseDir, 'global_embeddings.json'),
      JSON.stringify({ chunks: allCombinedChunks }, null, 2),
      'utf8'
    );

    console.log(`\n✨ Master Global Workspace Model built successfully!`);
    console.log(`📊 Total Repositories Mapped: ${reposScanned.length}`);
    console.log(`📄 Total Source Files Scanned: ${totalFiles}`);
    console.log(`🧩 Total Semantic Chunks Indexed: ${allCombinedChunks.length}`);

    return globalModel;
  }

  public static globalSearch(parentDir: string, query: string, topK: number = 10): SearchResult[] {
    const globalEmbeddingsPath = path.join(parentDir, '.codebase', 'global_embeddings.json');
    if (!fs.existsSync(globalEmbeddingsPath)) {
      this.scanAllRepositories(parentDir);
    }

    let data: { chunks: CodeChunk[] };
    try {
      data = JSON.parse(fs.readFileSync(globalEmbeddingsPath, 'utf8'));
    } catch {
      return [];
    }

    const queryTokens = SemanticSearchEngine.tokenize(query);
    if (queryTokens.length === 0) return [];

    const results: SearchResult[] = data.chunks.map(chunk => {
      const chunkTokens = chunk.tokens || SemanticSearchEngine.tokenize(chunk.content);
      const chunkTokenSet = new Set(chunkTokens);

      let matchCount = 0;
      queryTokens.forEach(qTerm => {
        if (chunkTokenSet.has(qTerm)) matchCount++;
      });

      const score = matchCount / queryTokens.length;

      return {
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        snippet: chunk.content,
        score
      };
    });

    return results
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
