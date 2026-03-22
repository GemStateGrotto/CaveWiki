# Implementation Details

Technical reference for the CaveWiki infrastructure. For an overview, see [README.md](README.md). For the build checklist, see [TODO.md](TODO.md).

## Stack Decomposition

Infrastructure is split into three dependent CDK stacks so that persistent storage survives compute teardowns.

| Stack | Resources | Depends On |
|---|---|---|
| **CaveWikiNetwork** | VPC (2 AZs, public subnets only), Security Groups (Fargate, Aurora, EFS) | — |
| **CaveWikiStorage** | Aurora Serverless v2 cluster, EFS file system + access point | Network |
| **CaveWikiCompute** | ECS cluster + Fargate service, Docker image (ECR via DockerImageAsset), Lambda DNS updater, CloudFront distribution, Route 53 records | Network, Storage |

Storage and Network stacks use `RemovalPolicy.RETAIN` on Aurora and EFS to protect data when the Compute stack is torn down.

## Configuration

All deployment configuration is provided via **CDK context values**, injected by `scripts/deploy.sh` which maps environment variables to `--context` flags. Context values can also be set in `cdk/cdk.json` or passed directly as CLI flags.

### CDK Context Keys

| Context Key | Required | Description | Example |
|---|---|---|---|
| `domainName` | Yes | Public hostname for the wiki | `wiki.example.org` |
| `hostedZoneId` | Yes | Route 53 hosted zone ID | `Z0123456789ABCDEFGHIJ` |
| `hostedZoneName` | Yes | Route 53 hosted zone domain name | `example.org` |
| `certificateArn` | Yes | ACM certificate ARN (**must be us-east-1**) | `arn:aws:acm:us-east-1:123456789012:certificate/abc-123` |
| `originRecordName` | No | Subdomain for the Fargate origin AAAA record (default: `origin`) | `origin` |

### Secrets File

The devcontainer mounts `~/.secrets/cavewiki` from the host and auto-sources it in every terminal session (see `.devcontainer/on_create.sh`). This file provides the environment variables that `scripts/deploy.sh` maps to CDK context values.

**Format** (`~/.secrets/cavewiki`):

```bash
# CaveWiki deployment configuration
CAVEWIKI_DOMAIN=wiki.example.org
CAVEWIKI_HOSTED_ZONE_ID=Z0123456789ABCDEFGHIJ
CAVEWIKI_HOSTED_ZONE_NAME=example.org
CAVEWIKI_CERTIFICATE_ARN=arn:aws:acm:us-east-1:123456789012:certificate/abc-123

# Optional
CAVEWIKI_ORIGIN_RECORD_NAME=origin
AWS_DEFAULT_REGION=us-west-2
```

### SSM Parameters (MediaWiki Secrets)

MediaWiki requires a `$wgSecretKey` and `$wgUpgradeKey`. These are stored as SSM Parameter Store SecureString parameters and injected into the Fargate task as container secrets.

| SSM Parameter Path | Description |
|---|---|
| `/cavewiki/mediawiki-secret-key` | 64-char hex string used by MediaWiki for HMAC |
| `/cavewiki/mediawiki-upgrade-key` | 16-char hex string used for web-based upgrades |
| `/cavewiki/origin-verify-secret` | 32-char hex string shared between CloudFront custom origin header and Apache validation |

Create these with `scripts/setup-secrets.sh` (generates random values, idempotent).

Aurora database credentials are managed automatically by CDK — stored in Secrets Manager (free for RDS-managed secrets) and injected into the Fargate task.

## Architecture Decisions

| Decision | Choice | Rationale |
|---|---|---|
| CDK language | TypeScript | Most common CDK language, strong typing, Node.js pre-installed in devcontainer |
| Authentication | MediaWiki built-in | Simplest approach; disable anonymous read/edit/createaccount in `LocalSettings.php` |
| Domain management | Route 53 | Simplifies CloudFront + origin DNS; single service for both public and origin records |
| ACM certificate | User-provided ARN | Outside CDK scope; avoids coupling the deployment to certificate lifecycle |
| Docker image | Official `mediawiki:1.45` + customization | Reliable base, add SMW via Composer layer |
| Container registry | CDK `DockerImageAsset` → ECR | Automatic; CDK builds, tags, and pushes the image to a CDK-managed ECR repo |
| Database secrets | CDK-managed Secrets Manager | Free for RDS-managed credentials; auto-generated, auto-rotatable |
| MediaWiki secrets | SSM Parameter Store SecureString | Cheaper than Secrets Manager ($0 vs $0.40/secret/mo); created once via script |
| VPC design | Dual-stack public subnets + IPv6-only public subnets, no NAT | Dual-stack subnets host Aurora/EFS (need IPv4); IPv6-only subnets host Fargate (no public IPv4, no IPv4 charge). No NAT Gateway ($32+/mo saved). |
| Fargate networking | IPv6-only, no public IPv4 | `assignPublicIp: false` in IPv6-only subnets. CloudFront connects over IPv6. Eliminates $3.60/mo public IPv4 charge. |
| Fargate SG ingress | `::/0` on port 80 | CloudFront connects over IPv6; custom origin header (`X-Origin-Verify`) validates requests at Apache layer |
| CloudFront origin | Lambda-updated Route 53 AAAA record | Fargate IPv6 addresses are assigned per-task; Lambda on ECS task state change event updates a Route 53 AAAA record (TTL 60s) for CloudFront |
| Origin access control | Custom origin header (`X-Origin-Verify`) | CloudFront injects a secret header; Apache returns 403 without it. Ensures only our distribution can reach the origin. Secret stored in SSM, injected into both CloudFront and the container |
| CloudFront caching | Disabled (full passthrough) | MediaWiki serves dynamic, authenticated content; caching would break auth |
| Background jobs | Sidecar container | Runs in the same Fargate task; simplest approach, no extra scheduling infrastructure |
| Fargate sizing | 0.5 vCPU / 1 GB | Enough for light-use MediaWiki; cheapest non-trivial Fargate config (~$29/mo) |
| Aurora capacity | 0–1 ACU, auto-pause | Scale-to-zero saves ~$40/mo when idle; 25-30s cold start acceptable; `LocalSettings.php` uses 60s connect timeout |
| Config model | CDK context (cdk.json + CLI) | Repo stays reusable; `scripts/deploy.sh` maps env vars to `--context` flags |

## Security Notes

- **All access is private**: `$wgGroupPermissions['*']['read'] = false` — unauthenticated users cannot read any page
- **No public registration**: `$wgGroupPermissions['*']['createaccount'] = false` — admins must create accounts
- **HTTPS enforced**: CloudFront redirects HTTP → HTTPS; viewer protocol is always TLS
- **Origin traffic is HTTP**: CloudFront → Fargate is HTTP-only on port 80 (TLS terminates at CloudFront). Standard practice for CloudFront origins in the same AWS network.
- **Origin restricted to CloudFront**: Apache validates a custom `X-Origin-Verify` header on every request. CloudFront injects this header with a shared secret (stored in SSM). Direct requests without the header receive 403.
- **Database not publicly accessible**: Aurora is in public subnets but its security group only allows inbound from the Fargate security group on port 3306
- **EFS restricted**: Security group only allows inbound NFS (2049) from the Fargate security group
- **ECS Exec not available**: ECS Exec is not supported in IPv6-only mode. Use `aws ecs run-task` with command overrides for initial setup and debugging.

## Initial MediaWiki Installation

After the first deploy, the database is empty. ECS Exec is not available in IPv6-only mode, so use `aws ecs run-task` with a command override to run setup commands in a one-off task (same task definition, same network config, custom command). Replace placeholder values below with your chosen admin username and password.

```bash
# Find the cluster and task definition
CLUSTER_ARN=$(aws ecs list-clusters --query 'clusterArns[?contains(@, `CaveWiki`)]' --output text)
TASK_DEF=$(aws ecs list-task-definitions --family-prefix CaveWikiCompute --sort DESC --query 'taskDefinitionArns[0]' --output text)

# Run install.php as a one-off task
aws ecs run-task \
  --cluster "$CLUSTER_ARN" \
  --task-definition "$TASK_DEF" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<ipv6-only-subnet-id>],securityGroups=[<fargate-sg-id>],assignPublicIp=DISABLED}" \
  --overrides '{
    "containerOverrides": [{
      "name": "mediawiki",
      "command": ["php", "maintenance/install.php",
        "--dbserver", "$MW_DB_HOST",
        "--dbname", "cavewiki",
        "--dbuser", "admin",
        "--dbpass", "$MW_DB_PASSWORD",
        "--server", "$MW_SERVER",
        "--scriptpath", "",
        "--pass", "<your-admin-password>",
        "CaveWiki", "<your-admin-username>"]
    }]
  }'

# Then run update.php for Semantic MediaWiki tables
aws ecs run-task \
  --cluster "$CLUSTER_ARN" \
  --task-definition "$TASK_DEF" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<ipv6-only-subnet-id>],securityGroups=[<fargate-sg-id>],assignPublicIp=DISABLED}" \
  --overrides '{
    "containerOverrides": [{
      "name": "mediawiki",
      "command": ["php", "maintenance/update.php", "--quick"]
    }]
  }'
```

> **Note**: The cluster lookup above matches by name substring. If you have multiple ECS clusters containing "CaveWiki", set `CLUSTER_ARN` explicitly. Replace `<ipv6-only-subnet-id>` and `<fargate-sg-id>` with actual values from the CloudFormation outputs.

## Cost Estimate

Based on us-west-2 pricing for light usage (a few users, sporadic access):

| Resource | Monthly Estimate |
|---|---|
| Fargate (0.5 vCPU / 1 GB, 24/7, IPv6-only — no public IPv4) | ~$29 |
| Aurora Serverless v2 (mostly paused, occasional use) | ~$2–5 |
| EFS (minimal storage, Elastic throughput) | ~$1 |
| CloudFront (light traffic, no caching) | ~$1 |
| Route 53 hosted zone | $0.50 |
| ECR / Lambda / CloudWatch / misc | ~$0.50 |
| **Total** | **~$34–38/mo** |

The main cost driver is Fargate at ~$29/mo (no public IPv4 charge). To stop paying for compute while preserving data: `cd cdk && npx cdk destroy CaveWikiCompute`.
