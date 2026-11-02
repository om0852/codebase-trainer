# Tree-sitter grammars

Pre-compiled WebAssembly grammars loaded by `src/parsing/treeSitter.ts` through `web-tree-sitter`. They are committed (about 3.7 MB) so that neither users nor CI install the native grammar packages or run their build scripts.

| File | Source package | Version | License |
|---|---|---|---|
| `tree-sitter-typescript.wasm` | [tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript) | 0.23.2 | MIT |
| `tree-sitter-tsx.wasm` | [tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript) | 0.23.2 | MIT |
| `tree-sitter-javascript.wasm` | [tree-sitter-javascript](https://github.com/tree-sitter/tree-sitter-javascript) | 0.25.0 | MIT |
| `tree-sitter-python.wasm` | [tree-sitter-python](https://github.com/tree-sitter/tree-sitter-python) | 0.25.0 | MIT |

To update one, install the package version somewhere outside the repo with `npm install --ignore-scripts <package>@<version>`, copy its `.wasm` file here, update this table, and run `npm test` and `npm run bench`.
