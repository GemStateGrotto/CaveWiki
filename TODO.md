# CaveWiki — Implementation TODO

Checklist for building out the PoC infrastructure. Each phase depends on the previous. Every phase includes success criteria that must pass before moving on.

---

## Phase 1–4: Scaffolding, Network, Storage & Docker Image (Complete)

- [x] **Phase 1 — Scaffolding**: CDK project, context keys, `config.ts`, `deploy.sh`, directory structure
- [x] **Phase 2 — Network Stack**: VPC (2 AZs, dual-stack public + IPv6-only subnets), Security Groups (ECS, EFS), no NAT
- [x] **Phase 3 — Storage Stack**: EFS (encrypted, Elastic throughput, access point UID/GID 33, RETAIN)
- [x] **Phase 4 — Docker Image**: `mediawiki:1.45` base, Semantic MediaWiki via Composer, `LocalSettings.php` (all env vars), origin-verify Apache config, jobrunner sidecar script

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for details on completed infrastructure.

---

## Phase 5: Compute Stack — `cdk/lib/compute-stack.ts`

Depends on: NetworkStack, StorageStack. Requires Phase 4 Docker image files to exist in `docker/mediawiki/`.

### ECS Cluster & EC2 Capacity

- [x] ECS Cluster with EC2 capacity provider (no Fargate)
- [x] Auto Scaling Group: min=0, max=1, desired=1
- [x] Instance type: `t4g.micro` (ARM, 1 GB RAM)
- [x] AMI: ECS-optimized Amazon Linux 2023 (ARM64)
- [x] Subnet: IPv6-only public subnet from NetworkStack (single AZ — must match EBS volume AZ)
- [x] Security group: ECS SG from NetworkStack
- [x] Instance profile with ECS + SSM + Route 53 + EBS permissions
- [x] `--enable-primary-ipv6` on instance launch

### EC2 User Data

- [x] Configure ECS agent for IPv6-only: set `ECS_INSTANCE_IP_COMPATIBILITY=ipv6` in `/etc/ecs/ecs.config`
- [x] Configure SSM Agent for dual-stack endpoints (same pattern as existing debug instance)
- [x] Attach EBS volume by tag, format if new (`mkfs.ext4`), mount to `/mnt/data`
- [x] Create `/mnt/data/sqlite` directory (owned by UID 33 / www-data)
- [x] Query instance metadata for IPv6 address, UPSERT Route 53 AAAA record for `{originRecordName}.{hostedZoneName}` (TTL 60s)

### EBS Volume (in Storage Stack)

- [x] 20 GB gp3 volume, pinned to a single AZ (must match EC2 instance AZ)
- [x] Tagged for discovery by user data script
- [x] Removal policy: RETAIN

### Task Definition (EC2 launch type)

- [x] Network mode: `host`
- [x] EFS volume definition referencing the EFS access point from StorageStack
- [x] Bind mount volume: host path `/mnt/data/sqlite` → container path `/var/www/html/data`

#### Main container (`mediawiki`)

- [x] Image: `DockerImageAsset` from `docker/mediawiki/` (dual-stack ECR URI for IPv6 pull)
- [x] Port mapping: host port 80 → container port 80
- [x] Environment variables:
  - `MW_SERVER` — full public URL, constructed from `domainName` CDK context (e.g., `https://{domainName}`)
  - `MW_SITENAME` — wiki name (default: `CaveWiki`)
- [x] Secrets (injected from SSM):
  - `MW_SECRET_KEY` — from SSM `/cavewiki/mediawiki-secret-key`
  - `MW_UPGRADE_KEY` — from SSM `/cavewiki/mediawiki-upgrade-key`
  - `MW_ORIGIN_VERIFY` — from SSM `/cavewiki/origin-verify-secret`
- [x] EFS volume mount at `/var/www/html/images`
- [x] EBS bind mount at `/var/www/html/data` (SQLite database)
- [x] Essential: true
- [x] Health check: `curl -f http://localhost/api.php`

#### Sidecar container (`jobrunner`)

- [x] Same image as main container
- [x] Override command: execute `jobrunner.sh`
- [x] Same environment variables, secrets, and volume mounts as main container
- [x] Essential: false (web container survives if jobrunner crashes)
- [x] No port mappings

### ECS Service

- [x] Desired count: 1
- [x] Capacity provider: EC2 (ASG-backed)
- [x] Enable ECS `dualStackIPv6` account setting for the account/region

### CloudFront Distribution

- [x] Origin domain: `{originRecordName}.{hostedZoneName}` (AAAA record updated by EC2 user data on boot)
- [x] Origin protocol policy: HTTP only (TLS terminates at CloudFront)
- [x] Custom origin header: `X-Origin-Verify: <secret>` — value read from SSM `/cavewiki/origin-verify-secret`
- [x] Cache policy: `CachePolicy.CACHING_DISABLED`
- [x] Origin request policy: `OriginRequestPolicy.ALL_VIEWER` (forward all headers, cookies, query strings)
- [x] Viewer protocol policy: Redirect HTTP → HTTPS
- [x] Alternate domain names: `[domainName]` from CDK context
- [x] Viewer certificate: ACM cert imported from ARN in CDK context (must be us-east-1)
- [x] Origin IP address type: IPv6-only (origin only has AAAA record)

### Route 53 Records

- [x] Alias A + AAAA records: `domainName` → CloudFront distribution domain name
- [x] (The origin AAAA record is managed by EC2 user data, not by CDK — CDK should not create it to avoid conflicts)

### Docker Image Changes

- [x] `LocalSettings.php`: Switch from MySQL to SQLite (`$wgDBtype = 'sqlite'`, `$wgSQLiteDataDir`)
- [x] Remove MySQL-specific env vars (`MW_DB_HOST`, `MW_DB_PASSWORD`, `MW_DB_USER`)
- [x] Ensure `php-sqlite3` is available in the base image (shipped with `mediawiki:1.45`)

### Items Removed from Previous Design

- ~~Lambda DNS Updater~~ — replaced by EC2 user data script (instance updates its own AAAA record on boot)
- ~~Debug EC2 instance~~ — unnecessary; SSM Session Manager into the ECS host directly
- ~~RDS MySQL~~ — replaced by SQLite on EBS
- ~~DB Security Group~~ — no longer needed
- ~~Secrets Manager DB credentials~~ — no database credentials with SQLite
- ~~Fargate service~~ — replaced by EC2 capacity provider

### Origin Chain Validation (gate — must pass before Phase 7)

After deploying the Compute stack, validate the full origin chain end-to-end.

- [x] EC2 instance joins ECS cluster and task reaches RUNNING state
- [x] Route 53 origin AAAA record is populated (updated by user data): `dig AAAA {originRecordName}.{hostedZoneName}`
- [x] Origin header validation via SSM session to the host:
  - `curl` without header → 403 ✅
  - `curl -H 'X-Origin-Verify: <secret>'` → 503 pre-install (origin-verify passes through; will be 200/302 after `install.php`)
- [x] CloudFront chain responds: `curl -I https://{domainName}` returns via CloudFront (`server: Apache`, `via: CloudFront`) ✅
- [x] Force instance replacement and confirm AAAA record updates to new IPv6 within ~60s

### Phase 5 Success Criteria

- [x] `npx cdk synth CaveWikiCompute` produces valid CloudFormation with no errors
- [x] Template contains ECS cluster with EC2 capacity provider, ASG, launch template (t4g.micro ARM)
- [x] Task definition has two containers: `mediawiki` (essential=true, port 80) and `jobrunner` (essential=false)
- [x] Task definition references both EFS volume and EBS bind mount
- [x] Template contains CloudFront distribution with CachingDisabled policy
- [x] No Lambda function or EventBridge rule in the template
- [x] All Origin Chain Validation checks above pass

---

## Phase 6: Deployment Scripts

- [x] **scripts/setup-secrets.sh**: SSM SecureString parameters (`mediawiki-secret-key`, `mediawiki-upgrade-key`, `origin-verify-secret`), idempotent
- [x] **scripts/deploy.sh**: Validates env vars, maps to CDK `--context` flags, runs `cdk deploy --all`

---

## Phase 7: End-to-End Verification & Initial Setup

### Pre-Deploy Verification

- [ ] `cd cdk && npx cdk synth` — all three CloudFormation templates synthesize without errors
- [ ] `docker build docker/mediawiki/` — Docker image builds successfully

### Deploy

- [ ] `./scripts/deploy.sh` — all three stacks deployed

### Post-Deploy Infrastructure Checks

- [ ] All three stacks show CREATE_COMPLETE in CloudFormation console
- [ ] EC2 instance running, registered in ECS cluster
- [ ] ECS task reaches RUNNING state with both containers healthy
- [ ] EBS volume attached and mounted at `/mnt/data`
- [ ] Route 53: origin AAAA record populated by user data
- [ ] CloudFront distribution status is "Deployed"
- [ ] `curl -I https://{domainName}` returns a response via CloudFront

### Initial MediaWiki Installation

Use SSM Session Manager to connect to the EC2 host and `docker exec` into the running mediawiki container. See [IMPLEMENTATION.md](IMPLEMENTATION.md#initial-mediawiki-installation) for full commands.

- [ ] Run `php maintenance/install.php` with `--dbtype sqlite` (creates SQLite database on EBS volume)
- [ ] Run `php maintenance/update.php --quick` (Semantic MediaWiki table setup)
- [ ] Verify initial admin user was created by `install.php`

### Functional Verification

- [ ] Browse to `https://{domainName}` — redirects to login page (not the wiki content)
- [ ] Log in with admin credentials — wiki main page loads
- [ ] In an incognito/private window, `https://{domainName}` shows only a login form (anonymous read blocked)
- [ ] Create a test page with Semantic MediaWiki annotations (e.g., `[[Has type::Page]]`) — page saves without errors
- [ ] Upload a test file — upload succeeds, file is accessible after upload
- [ ] Force instance replacement — after restart, uploaded file and wiki content still exist (confirms EBS and EFS persistence)
- [ ] Check CloudWatch Logs: the `jobrunner` log stream shows job processing output

---

## Phase 8: Agent Skill Files

Create VS Code Copilot agent skill files (`.github/copilot/skills/`) for repeatable tasks so that future agent interactions can execute these workflows reliably.

### Validate & Test Skill

- [ ] Create `.github/copilot/skills/validate/SKILL.md`
- [ ] Skill should define the full validation workflow:
  1. `cd cdk && npx tsc --noEmit` — TypeScript compilation check
  2. `cd cdk && npx cdk synth` — CloudFormation synthesis
  3. `docker build docker/mediawiki/` — Docker image build
  4. Verify no hardcoded environment-specific values in synthesized templates or Docker image
- [ ] Skill should describe expected outputs and how to interpret failures
- [ ] Skill should be invocable by asking the agent to "validate the CDK config" or "run tests"

### Deploy Skill

- [ ] Create `.github/copilot/skills/deploy/SKILL.md`
- [ ] Skill should define the full deployment workflow:
  1. Run the validation workflow first (reference the validate skill)
  2. Verify required env vars are set in the current shell
  3. Run `./scripts/deploy.sh`
  4. Run post-deploy checks (task RUNNING, DNS updated, CloudFront responding)
- [ ] Skill should describe rollback steps if deploy fails
- [ ] Skill should be invocable by asking the agent to "deploy to production" or "push to AWS"

### Infrastructure Inspection Skill

- [ ] Create `.github/copilot/skills/inspect/SKILL.md`
- [ ] Skill should define how to check the current state of the deployment:
  1. List CloudFormation stack statuses
  2. Check ECS task status and container health
  3. Verify Route 53 origin AAAA record matches current EC2 IPv6
  4. Check CloudFront distribution status
  5. Test HTTPS endpoint connectivity
  6. Tail recent CloudWatch Logs for mediawiki and jobrunner containers
- [ ] Skill should be invocable by asking the agent to "check deployment status" or "inspect infrastructure"

### Phase 8 Success Criteria

- [ ] Each skill file exists at the correct path and follows the VS Code Copilot skill file format (YAML frontmatter + markdown body)
- [ ] Each skill can be triggered by the agent when using natural language matching its description
- [ ] Validate skill: agent can run the full validation pipeline and report pass/fail
- [ ] Deploy skill: agent can execute a deployment end-to-end (given env vars are set)
- [ ] Inspect skill: agent can report current infrastructure status with actionable output

---

## Future Enhancements (Post-PoC)

These are not part of the current build but are tracked for later iterations.

### App Runner Migration (Production Target)

- [ ] Replace EFS media storage with S3 + presigned URLs (upload POST, direct download)
- [ ] Replace SQLite with RDS MySQL/Aurora Serverless v2 (required for multi-instance concurrency)
- [ ] Create new compute stack using AWS App Runner (auto-scaling, managed TLS, no ECS/EC2 to manage)
- [ ] Update CloudFront origin to App Runner service URL (or remove CloudFront if App Runner handles TLS directly)
- [ ] Remove EC2/ECS-specific resources (ASG, capacity provider, EBS volume, user data DNS script)

### Security Hardening

- [ ] Restrict ECS SG inbound to CloudFront managed prefix list (`com.amazonaws.global.cloudfront.origin-facing`) in addition to the custom origin header (defense-in-depth)

### Operational

- [ ] Enable AWS Backup for EFS (~$0.05/GB/mo) and EBS snapshots
- [ ] Set up CloudWatch alarms (EC2 health, ECS task status, EFS throughput, disk usage)
- [ ] Consider scheduled instance stop/start (scale ASG to 0 at night) if usage patterns allow
