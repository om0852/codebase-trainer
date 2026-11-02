# Test impact phase6

44 source files of this repo, each made to throw on load; 14 test files.

| Source file | Tests selected | Tests that failed | Failing tests selected |
|---|---|---|---|
| src/ci/sarifExporter.ts | 0 | 0 | 0 |
| src/classifier/intentClassifier.ts | 12 | 12 | 12 |
| src/context/contextPack.ts | 1 | 1 | 1 |
| src/context/featureSlice.ts | 1 | 1 | 1 |
| src/context/skeletonizer.ts | 2 | 2 | 2 |
| src/enterprise/onboardingDocs.ts | 0 | 0 | 0 |
| src/enterprise/prReviewer.ts | 0 | 0 | 0 |
| src/extractors/astExtractor.ts | 14 | 14 | 14 |
| src/extractors/codebaseIgnore.ts | 14 | 14 | 14 |
| src/extractors/gitignore.ts | 14 | 14 | 14 |
| src/fixer/autoFixer.ts | 0 | 0 | 0 |
| src/flow/adapters.ts | 7 | 7 | 7 |
| src/flow/callSites.ts | 7 | 7 | 7 |
| src/flow/executionFlow.ts | 2 | 2 | 2 |
| src/git/gitMiner.ts | 7 | 7 | 7 |
| src/git/hooks.ts | 1 | 0 | 0 |
| src/graph/architectureDiagram.ts | 1 | 1 | 1 |
| src/graph/callGraph.ts | 9 | 9 | 9 |
| src/graph/impactAnalyzer.ts | 2 | 2 | 2 |
| src/graph/importResolver.ts | 13 | 13 | 13 |
| src/graph/pageRank.ts | 7 | 7 | 7 |
| src/graph/testImpact.ts | 5 | 5 | 5 |
| src/microservices/contractDrift.ts | 7 | 7 | 7 |
| src/microservices/routeRegistry.ts | 1 | 0 | 0 |
| src/miner/conventionMiner.ts | 7 | 7 | 7 |
| src/miner/docstringMiner.ts | 7 | 7 | 7 |
| src/multi/globalIndex.ts | 0 | 0 | 0 |
| src/parsing/codeFacts.ts | 14 | 14 | 14 |
| src/parsing/treeSitter.ts | 14 | 14 | 14 |
| src/quality/duplicationScanner.ts | 1 | 1 | 1 |
| src/review/diffChecker.ts | 3 | 3 | 3 |
| src/review/diffParser.ts | 3 | 3 | 3 |
| src/security/permissionMap.ts | 3 | 3 | 3 |
| src/security/secretSanitizer.ts | 10 | 10 | 10 |
| src/security/vulnerabilityScanner.ts | 4 | 4 | 4 |
| src/semantic/denseVectorEngine.ts | 6 | 6 | 6 |
| src/semantic/searchEngine.ts | 6 | 6 | 6 |
| src/semantic/textNormalizer.ts | 6 | 6 | 6 |
| src/storage/db.ts | 6 | 0 | 0 |
| src/storage/encryption.ts | 7 | 7 | 7 |
| src/types/index.ts | 14 | 0 | 0 |
| src/ui/dashboardGenerator.ts | 2 | 2 | 2 |
| src/validator/modelValidator.ts | 1 | 1 | 1 |
| src/watcher/fileWatcher.ts | 1 | 1 | 1 |
| **all** | 5.5 avg of 14 | 220 | 220 (recall 100%) |

No failing test was left out of the selection.

A load failure breaks every test that reaches the file, so selected-but-passing tests show only where a test reaches the file without loading it. This measures recall and suite reduction, not precision.
