# Implementation Details

Technical reference for the CaveWiki infrastructure. For an overview, see [README.md](README.md). For the build checklist, see [TODO.md](TODO.md).

## Stack Decomposition

Infrastructure is split into three dependent CDK stacks so that persistent storage survives compute teardowns.

| Stack | Resources | Depends On |
|---|---|---|
| **CaveWikiNetwork** | VPC (2 AZs, dual-stack public + IPv6-only subnets), Security Groups (ECS, EFS) | — |
| **CaveWikiStorage** | EBS volume (20 GB gp3, single AZ), EFS file system + access point | Network |
| **CaveWikiCompute** | ECS cluster + EC2 capacity provider (t4g.micro ARM), Docker image (ECR via DockerImageAsset), CloudFront distribution, Route 53 records | Network, Storage |

Storage and Network stacks use `RemovalPolicy.RETAIN` on EBS and EFS to protect data when the Compute stack is torn down.

## Configuration

All deployment configuration is provided via **CDK context values**, injected by `scripts/deploy.sh` which maps environment variables to `--context` flags. Context values can also be set in `cdk/cdk.json` or passed directly as CLI flags.

### CDK Context Keys

| Context Key | Required | Description | Example |
|---|---|---|---|
| `domainName` | Yes | Public hostname for the wiki | `wiki.example.org` |
| `hostedZoneId` | Yes | Route 53 hosted zone ID | `Z0123456789ABCDEFGHIJ` |
| `hostedZoneName` | Yes | Route 53 hosted zone domain name | `example.org` |
| `certificateArn` | Yes | ACM certificate ARN (**must be us-east-1**) | `arn:aws:acm:us-east-1:123456789012:certificate/abc-123` |
| `originRecordName` | No | Subdomain for the origin AAAA record (default: `origin`) | `origin` |

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

MediaWiki requires a `$wgSecretKey` and `$wgUpgradeKey`. These are stored as SSM Parameter Store SecureString parameters and injected into the ECS task as container secrets.

| SSM Parameter Path | Description |
|---|---|
| `/cavewiki/mediawiki-secret-key` | 64-char hex string used by MediaWiki for HMAC |
| `/cavewiki/mediawiki-upgrade-key` | 16-char hex string used for web-based upgrades |
| `/cavewiki/origin-verify-secret` | 32-char hex string shared between CloudFront custom origin header and Apache validation |

Create these with `scripts/setup-secrets.sh` (generates random values, idempotent).

## Architecture Decisions

| Decision | Choice | Rationale |
|---|---|---|
| CDK language | TypeScript | Most common CDK language, strong typing, Node.js pre-installed in devcontainer |
| Authentication | MediaWiki built-in | Simplest approach; disable anonymous read/edit/createaccount in `LocalSettings.php` |
| Domain management | Route 53 | Simplifies CloudFront + origin DNS; single service for both public and origin records |
| ACM certificate | User-provided ARN | Outside CDK scope; avoids coupling the deployment to certificate lifecycle |
| Docker image | Official `mediawiki:1.45` + customization | Reliable base, add SMW via Composer layer |
| Container registry | CDK `DockerImageAsset` → ECR | Automatic; CDK builds, tags, and pushes the image to a CDK-managed ECR repo |
| MediaWiki secrets | SSM Parameter Store SecureString | Cheaper than Secrets Manager ($0 vs $0.40/secret/mo); created once via script |
| VPC design | Dual-stack public subnets + IPv6-only public subnets, no NAT | Dual-stack subnets host EFS mount targets (need IPv4); IPv6-only subnets host EC2/ECS. No NAT Gateway ($32+/mo saved). |
| EC2 networking | IPv6-only subnet, `host` network mode | ECS on EC2 fully supports IPv6-only subnets (agent v1.99.1+). Uses `--enable-primary-ipv6` and `ECS_INSTANCE_IP_COMPATIBILITY=ipv6`. SSM Agent configured for dual-stack endpoints. CloudFront connects over IPv6. No public IPv4 charge. |
| ECS SG ingress | `::/0` on port 80 | CloudFront connects over IPv6; custom origin header (`X-Origin-Verify`) validates requests at Apache layer |
| Origin DNS | EC2 user data updates Route 53 AAAA record on boot | Single-instance design; the instance queries its own IPv6 from instance metadata and UPSERTs the AAAA record. Simpler than the event-driven Lambda pattern used in the previous Fargate design. |
| Origin access control | Custom origin header (`X-Origin-Verify`) | CloudFront injects a secret header; Apache returns 403 without it. Ensures only our distribution can reach the origin. Secret stored in SSM, injected into both CloudFront and the container |
| CloudFront caching | Disabled (full passthrough) | MediaWiki serves dynamic, authenticated content; caching would break auth |
| Background jobs | Sidecar container | Runs in the same ECS task; simplest approach, no extra scheduling infrastructure |
| Compute | EC2 t4g.micro (ARM), 1 GB RAM | ~$6/mo vs ~$29/mo for Fargate. Sufficient for 1-2 users with light usage. t4g.small (2 GB, ~$12/mo) is the escape hatch if memory is tight. |
| Database | SQLite on EBS | Zero cost, zero operational overhead. Officially supported by MediaWiki. No concurrency concerns at PoC scale (1-2 users). EBS volume survives instance replacement when RETAIN policy is set. |
| Media storage | EFS | Shared filesystem survives instance replacements. Access point with UID/GID 33 (www-data). Will be replaced with S3 in the App Runner migration. |
| EBS volume | 20 GB gp3, single AZ, RETAIN | Hosts SQLite database. Pinned to one AZ (must match EC2). Survives compute teardowns. |
| Config model | CDK context (cdk.json + CLI) | Repo stays reusable; `scripts/deploy.sh` maps env vars to `--context` flags |

## Security Notes

- **All access is private**: `$wgGroupPermissions['*']['read'] = false` — unauthenticated users cannot read any page
- **No public registration**: `$wgGroupPermissions['*']['createaccount'] = false` — admins must create accounts
- **HTTPS enforced**: CloudFront redirects HTTP → HTTPS; viewer protocol is always TLS
- **Origin traffic is HTTP**: CloudFront → EC2 is HTTP-only on port 80 (TLS terminates at CloudFront). Standard practice for CloudFront origins in the same AWS network.
- **Origin restricted to CloudFront**: Apache validates a custom `X-Origin-Verify` header on every request. CloudFront injects this header with a shared secret (stored in SSM). Direct requests without the header receive 403.
- **EFS restricted**: Security group only allows inbound NFS (2049) from the ECS security group
- **ECS Exec not available**: ECS Exec is not supported in IPv6-only mode. Use SSM Session Manager to connect to the EC2 host, then `docker exec` into the container.

## EC2 Instance User Data

The EC2 instance user data script performs the following on each boot:

1. **ECS agent config**: Sets `ECS_INSTANCE_IP_COMPATIBILITY=ipv6` and `ECS_CLUSTER` in `/etc/ecs/ecs.config`
2. **SSM Agent dual-stack**: Configures SSM Agent to use dual-stack endpoints (required for IPv6-only subnets — same pattern proven on the debug instance)
3. **EBS volume**: Attaches the tagged EBS volume, formats if new (`mkfs.ext4`), mounts to `/mnt/data`, creates `/mnt/data/sqlite` (owned by UID 33)
4. **Route 53 DNS**: Queries instance metadata for the IPv6 address, UPSERTs a Route 53 AAAA record (`{originRecordName}.{hostedZoneName}`, TTL 60s) using the AWS CLI

## LocalSettings.php — SQLite Configuration

The Docker image's `LocalSettings.php` configures MediaWiki for SQLite:

```php
$wgDBtype         = 'sqlite';
$wgDBname         = getenv('MW_DB_NAME') ?: 'cavewiki';
$wgSQLiteDataDir  = '/var/www/html/data';
```

The `/var/www/html/data` path is a bind mount from the host's `/mnt/data/sqlite` (EBS volume). No database host, user, or password is needed.

## Initial MediaWiki Installation

After the first deploy, the database does not exist yet. Use SSM Session Manager to connect to the EC2 host, then `docker exec` into the running mediawiki container.

```bash
# Connect to the EC2 instance via SSM
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=*CaveWiki*" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
aws ssm start-session --target "$INSTANCE_ID"

# Inside the instance, find the mediawiki container
CONTAINER_ID=$(docker ps --filter "name=mediawiki" --format '{{.ID}}' | head -1)

# Run install.php (SQLite — no --dbserver/--dbuser/--dbpass needed)
docker exec "$CONTAINER_ID" php maintenance/install.php \
  --dbtype sqlite \
  --dbpath /var/www/html/data \
  --dbname cavewiki \
  --server "$MW_SERVER" \
  --scriptpath "" \
  --pass "<your-admin-password>" \
  "CaveWiki" "<your-admin-username>"

# Run update.php for Semantic MediaWiki tables
docker exec "$CONTAINER_ID" php maintenance/update.php --quick
```

> **Note**: Replace `<your-admin-password>` and `<your-admin-username>` with your chosen credentials. The `$MW_SERVER` environment variable is already set inside the container.

## Cost Estimate

Based on us-west-2 pricing for light usage (a few users, sporadic access):

| Resource | Monthly Estimate |
|---|---|
| EC2 t4g.micro (1 vCPU / 1 GB, 24/7, IPv6-only) | ~$6 |
| EBS 20 GB gp3 | ~$1.60 |
| EFS (minimal storage, Elastic throughput) | ~$1 |
| CloudFront (light traffic, no caching) | ~$1 |
| Route 53 hosted zone | $0.50 |
| ECR / CloudWatch / misc | ~$0.50 |
| **Total** | **~$11/mo** |

To stop paying for compute while preserving data: `cd cdk && npx cdk destroy CaveWikiCompute`. EBS and EFS volumes are retained.

## Previous Fargate Design (Superseded)

The original PoC used Fargate (0.5 vCPU / 1 GB, ~$29/mo) with RDS MySQL (db.t4g.micro, ~$12/mo) at ~$44-46/mo total. That design included a Lambda DNS updater triggered by ECS task state changes to keep the Route 53 AAAA record current, plus a debug EC2 instance for IPv6 network diagnostics. The move to EC2 + SQLite eliminates the need for RDS, the Lambda, and the debug instance, reducing cost by ~70%.
