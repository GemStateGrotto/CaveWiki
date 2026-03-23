# CaveWiki

A private wiki for cave survey and exploration data, built on [MediaWiki](https://www.mediawiki.org/) with [Semantic MediaWiki](https://www.semantic-mediawiki.org/). Deployed to AWS using CDK, designed for light usage at minimal cost (~$44–46/mo).

All access is private — only authenticated users can read or edit. The repository is reusable: every environment-specific value (domain, certificate, hosted zone) is injected at deploy time, never hardcoded.

## Architecture

```
User → CloudFront (HTTPS) → Fargate (HTTP, port 80)
                                 ├── mediawiki container
                                 └── jobrunner sidecar
                                          │
                               ┌──────────┼──────────┐
                               │          │          │
                            RDS MySQL   EFS      Route 53
                           (db.t4g.micro) (media)  (origin DNS)
```

CloudFront handles HTTPS termination (no ALB needed). A Lambda watches ECS task state changes to keep a Route 53 AAAA record pointed at the Fargate task's IPv6 address, giving CloudFront a stable origin domain. A custom origin header ensures only the CloudFront distribution can reach the origin.

Infrastructure is split into three CDK stacks — **Network**, **Storage**, and **Compute** — so you can tear down and rebuild compute without losing data.

A future iteration will replace Fargate with Lambda (Bref PHP runtime) and EFS with S3 presigned URLs.

## Repository Layout

```
cdk/           CDK TypeScript infrastructure (stacks, Lambda handlers)
docker/        MediaWiki Docker image (Dockerfile, LocalSettings, extensions)
scripts/       Deployment and setup helpers
```

## Prerequisites

- **AWS account** with CLI credentials configured
- **Route 53 hosted zone** for your domain
- **ACM certificate** in **us-east-1** covering your wiki hostname
- **Secrets file** at `~/.secrets/cavewiki` on your host machine (format documented in [IMPLEMENTATION.md](IMPLEMENTATION.md#secrets-file))

The devcontainer provides Node.js, Docker, and the AWS CLI.

## Quick Start

```bash
# Install CDK CLI
npm install -g aws-cdk

# Install project dependencies
cd cdk && npm install && cd ..

# Create MediaWiki SSM secrets (one-time)
./scripts/setup-secrets.sh

# Bootstrap CDK (one-time per account+region)
cd cdk && npx cdk bootstrap && cd ..

# Deploy all stacks
./scripts/deploy.sh
```

After deploy, shell into the Fargate task to run the MediaWiki installer — see [IMPLEMENTATION.md](IMPLEMENTATION.md#initial-mediawiki-installation).

## Day-to-Day Operations

```bash
# Deploy changes
./scripts/deploy.sh

# Deploy a single stack
cd cdk && npx cdk deploy CaveWikiCompute

# Stop compute (preserves database and files)
cd cdk && npx cdk destroy CaveWikiCompute
```

## Documentation

| Document | Contents |
|---|---|
| [TODO.md](TODO.md) | Phased implementation checklist with success criteria |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | Stack details, configuration reference, architecture decisions, security notes, cost estimate |