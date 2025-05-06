# Contributing to CodeCompass

Thank you for considering contributing to CodeCompass! We welcome contributions from the community to improve this AI-powered MCP server for codebase navigation and LLM prompt optimization. Whether you're fixing bugs, adding features, or improving documentation, your efforts help make CodeCompass better for everyone.
How to Contribute
Reporting Issues

Check the GitHub Issues to ensure the issue hasn't been reported.
Open a new issue with a clear title and description, including:
Steps to reproduce the issue.
Expected and actual behavior.
Environment details (Node.js version, OS, etc.).

Use labels (e.g., bug, enhancement) to categorize the issue.

Submitting Pull Requests

Fork the Repository:

Fork the CodeCompass repository and clone your fork:git clone <https://github.com/your-username/codecompass.git>
cd codecompass

Create a Branch:

Create a new branch for your changes:git checkout -b feature/your-feature-name

Make Changes:

Follow the coding standards below.
Ensure your changes are well-tested and documented.
Update README.md or other documentation if necessary.

Commit Changes:

Use clear, descriptive commit messages:git commit -m "Add feature: describe your change"

Push and Create a Pull Request:

Push your branch to your fork:git push origin feature/your-feature-name

Open a pull request (PR) on the main repository, describing:
What the PR does.
Any related issues (e.g., Fixes #123).
Testing performed.

Code Review:

Respond to feedback from maintainers.
Make requested changes and update your PR.

Coding Standards

Language: Use JavaScript (Node.js v20+) with TypeScript optional.
Formatting: Follow ESLint/Prettier rules (configuration TBD; for now, match existing code style).
Testing: Add tests for new features or bug fixes (using Jest, TBD).
Documentation: Update README.md or other files for user-facing changes.

Development Setup

Clone the repository and install dependencies:git clone <https://github.com/your-username/codecompass.git>
cd codecompass
npm install

Set up prerequisites (Qdrant, Ollama) as described in README.md.
Run the server locally:node src/index.js /path/to/your/repo

Community

Join discussions on GitHub Discussions (coming soon).
Follow the Code of Conduct (TBD) to ensure a respectful environment.

Questions?
If you have questions or need help, open an issue or reach out via GitHub Discussions. We’re excited to have you contribute to CodeCompass!

Thank you for helping make CodeCompass better!
