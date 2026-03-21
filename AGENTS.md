# Project Guidelines

## Documentation Style

The README is a **concise entrypoint** — architecture overview, quick start, and pointers to other docs. It is not a reference manual. Keep it under ~100 lines of prose. If you're adding a table, a long code block, or a detailed explanation, it belongs in IMPLEMENTATION.md or TODO.md instead.

When documenting project structure, describe the **directory hierarchy** (what each top-level directory is for), not individual files. Readers can run `ls`. A three-line layout block is better than a 30-line tree.

## Configuration and Secrets

**Never hardcode environment-specific values** (domain names, ARNs, account IDs, hostnames) in source files, documentation, or examples. Use generic placeholders like `wiki.example.org` in docs and `getenv()` / CDK context in code.

Deployment configuration lives in the secrets file (`~/.secrets/cavewiki`) mounted by the devcontainer. Environment variables from that file are auto-sourced into every terminal session — scripts should **not** re-source them.

## CDK and Infrastructure

- CDK stacks are TypeScript, located in `cdk/`.
- Three stacks: Network → Storage → Compute. Storage and Network use `RemovalPolicy.RETAIN`.
- All CDK configuration is injected via context values, never hardcoded.
- The Docker image is built by CDK `DockerImageAsset` — no separate ECR management needed.

## Code Style

- Shell scripts use `set -e` and validate inputs before acting.
- PHP config (`LocalSettings.php`) reads all values from environment variables.
- Prefer the simplest approach that meets the stated cost and reliability goals.

## What Not to Do

- Don't add features, abstractions, or configurability beyond what's specified in TODO.md.
- Don't document things the reader can infer from the code or a directory listing.
- Don't duplicate content across README.md, IMPLEMENTATION.md, and TODO.md — cross-reference instead.

## Commit Messages

Keep concise: note what changed and why. Don't list design decisions or key features — that content already lives in the committed files. Explain the change but don't restate the code. A good commit message is a one- or two-line summary, not a mini design doc.

## Agent Learning

When you learn something project-specific that would typically go into agent memory, add it to this file instead so other contributors and agents benefit too.

## Actions Requiring Explicit Approval

Never perform these actions unless the user directly requests or approves them:

- **Deploying to production** (`cdk deploy`, `./scripts/deploy.sh`, or any AWS-mutating operation)
- **Committing code** (`git commit`)
- **Pushing to origin** (`git push`)
