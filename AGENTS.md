# Agent workflow

During normal development, make changes incrementally and rely on Vite hot reload. Do not restart the local development environment unless it is stopped, unresponsive, or the change specifically requires a restart. Do not stop the local environment merely to run end-to-end tests.

Do not run checks, automated tests, Playwright, or create screenshots after every small change. Batch validation and run it only when the user asks, or immediately before pushing to a remote Git repository.

Before a remote push, run the relevant checks and tests. For user-visible changes, run the relevant Playwright tests and store current screenshots under `test-results/screenshots/`.
