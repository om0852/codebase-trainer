# Contributing to Codebase Trainer

First off, thank you for considering contributing to Codebase Trainer! We welcome contributions from anyone, whether it's fixing bugs, improving documentation, or adding new MCP tools.

## 🚀 Getting Started

1. **Fork the repository** on GitHub.
2. **Clone your fork locally**:
   ```bash
   git clone https://github.com/your-username/codebase-trainer.git
   cd codebase-trainer
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```

## 🛠️ Development Workflow

We use standard TypeScript for the backend and Vite for the frontend website.

- **Build the CLI**: `npm run build`
- **Run tests**: `npm run test`
- **Start the MCP server locally**: `npm start`
- **Run the Website locally**: `npm run website:dev`

## 📝 Pull Request Guidelines

- Ensure your code passes all unit tests (`npm run test`).
- Run the security audit locally before pushing: `npm run security`.
- Keep your commits atomic and descriptive (we follow Conventional Commits: `feat:`, `fix:`, `docs:`).
- If you are adding a new MCP tool, ensure you update the `website/index.html` UI to reflect the new feature!

## 🐞 Reporting Bugs
If you find a bug, please create an issue on GitHub with a detailed description and steps to reproduce.
