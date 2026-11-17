# Contributing to offline-sync-kit

Thank you for your interest in contributing to `offline-sync-kit`!

## Development Setup

1. Clone or navigate to the repository:
   ```bash
   cd npm_pack
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run test suite:
   ```bash
   npm test
   ```
4. Check types:
   ```bash
   npm run typecheck
   ```
5. Build package:
   ```bash
   npm run build
   ```

## Pull Request Guidelines

- Ensure all Vitest unit and integration tests pass.
- Write new tests for any added features or bug fixes.
- Follow TypeScript strict guidelines (zero `any` without justification).
- Do not add runtime dependencies to the core package without prior discussion.
- Update `CHANGELOG.md` with relevant notes.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
