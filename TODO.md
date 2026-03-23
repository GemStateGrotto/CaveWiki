# CaveWiki — Implementation TODO

Checklist for building out the PoC infrastructure. Each phase depends on the previous. Every phase includes success criteria that must pass before moving on.

---

## Phase 1: Project Scaffolding

- [x] Initialize CDK TypeScript project in `cdk/` (`cdk init app --language typescript`)
- [x] Create `docker/mediawiki/` directory
- [x] Create `scripts/` directory
- [x] Define CDK context keys in `cdk/cdk.json`:
  - `domainName` — public wiki URL hostname
  - `hostedZoneId` — Route 53 hosted zone ID
  - `hostedZoneName` — Route 53 hosted zone domain name
  - `certificateArn` — ACM certificate ARN (must be in us-east-1 for CloudFront)
  - `originRecordName` — subdomain for Fargate origin AAAA record (default: `origin`)
- [x] Create `cdk/lib/config.ts` — reads CDK context values, validates required ones, provides defaults
- [x] Create `scripts/deploy.sh` — maps environment variables (already present in shell) to `--context` flags, runs `cdk deploy --all`

### Phase 1 Success Criteria

- [x] `cd cdk && npx tsc --noEmit` compiles with zero errors
- [x] `cd cdk && npx cdk synth` produces a CloudFormation template (even if nearly empty) without errors
- [x] `cdk/lib/config.ts` throws a clear error when a required context key is missing (test by running `npx cdk synth` without context values)
- [x] `scripts/deploy.sh` is executable and exits with a clear error message when required env vars are unset
- [x] Directory structure matches the repository layout in README.md

---

## Phase 2: Network Stack — `cdk/lib/network-stack.ts`

- [x] VPC with 2 AZs, public subnets only, no NAT gateway
- [x] Enable dual-stack: Amazon-provided IPv6 CIDR on VPC + IPv6 CIDR on each subnet
- [x] Route table: `::/0` → Internet Gateway (IPv6 egress)
- [x] Security Groups:
  - [x] **Fargate SG**: inbound TCP 80 from `::/0` (IPv6 — CloudFront connects over IPv6; custom origin header validates requests)
  - [x] **DB SG**: inbound TCP 3306 from Fargate SG only
  - [x] **EFS SG**: inbound TCP 2049 from Fargate SG only
- [x] Export VPC and all three security groups as stack outputs
- [x] Add IPv6-only public subnets (one per AZ) for Fargate — no IPv4 CIDR, IPv6 only
- [x] Route table for IPv6-only subnets: `::/0` → Internet Gateway
- [x] Export IPv6-only subnets separately for use by Compute stack
- [x] Ensure all resources have Name tags for easy identification in AWS Console

### Phase 2 Success Criteria

- [x] `npx cdk synth CaveWikiNetwork` produces valid CloudFormation with no errors
- [x] Template contains exactly one VPC (with IPv6 CIDR), four public subnets (two dual-stack for RDS/EFS, two IPv6-only for Fargate), three security groups
- [x] No NAT Gateway or NAT Instance resources appear in the synthesized template
- [x] Security group ingress rules match spec: Fargate SG allows 80/tcp from `::/0`; DB SG allows 3306/tcp from Fargate SG; EFS SG allows 2049/tcp from Fargate SG
- [x] `npx cdk deploy CaveWikiNetwork` succeeds and resources are visible in AWS Console

---

## Phase 3: Storage Stack — `cdk/lib/storage-stack.ts`

Depends on: NetworkStack

### RDS MySQL 8.0

- [x] Engine: MySQL 8.0
- [x] Instance class: db.t4g.micro
- [x] Single-AZ
- [x] Placed in public subnets, NOT publicly accessible (SG-restricted to Fargate SG)
- [x] Master credentials: CDK-generated, auto-stored in Secrets Manager (free for RDS-managed)
- [x] Removal policy: RETAIN

### EFS

- [x] Encrypted at rest
- [x] Performance mode: General Purpose
- [x] Throughput mode: Elastic (pay-per-use)
- [x] Mount targets in each public subnet
- [x] Access point: UID/GID 33 (www-data), root directory path `/mediawiki-images`
- [x] Removal policy: RETAIN

### Exports

- [x] DB instance endpoint + port
- [x] Secrets Manager secret ARN (for DB credentials)
- [x] EFS file system ID + access point ID

### Phase 3 Success Criteria

- [x] `npx cdk synth CaveWikiStorage` produces valid CloudFormation with no errors
- [x] Template contains RDS MySQL instance (db.t4g.micro)
- [x] Template contains EFS file system with Encrypted=true and an access point with PosixUser UID/GID 33
- [x] RDS and EFS resources have DeletionPolicy=Retain in the synthesized template
- [x] `npx cdk deploy CaveWikiStorage` succeeds
- [x] RDS instance visible in RDS console with status "Available"
- [x] Secrets Manager contains the auto-generated DB credentials secret
- [x] EFS file system visible in EFS console with mount targets in both AZs

---

## Phase 4: Docker Image — `docker/mediawiki/`

### Dockerfile

- [x] Base image: `mediawiki:1.45`
- [x] Install `curl` for health checks (if not already in base)
- [x] Copy `composer.local.json` into the MediaWiki directory
- [x] Run `composer update --no-dev` to install Semantic MediaWiki
- [x] Verify Composer exits 0 and all SMW dependencies resolve without conflicts
- [x] Copy `LocalSettings.php` into place
- [x] Copy `origin-verify.conf` Apache config into `/etc/apache2/conf-enabled/`
- [x] Copy `jobrunner.sh` and make it executable

### composer.local.json

- [x] Require `mediawiki/semantic-media-wiki: ~6.0`

### LocalSettings.php

All configuration via `getenv()` — no hardcoded values.

- [x] Database config:
  - `$wgDBserver = getenv('MW_DB_HOST')`
  - `$wgDBname = getenv('MW_DB_NAME') ?: 'cavewiki'`
  - `$wgDBpassword = getenv('MW_DB_PASSWORD')`
- [x] `$wgDBuser = 'admin'` (RDS default master user)
  - `$wgDBtype = 'mysql'`
- [x] Site config:
  - `$wgServer = getenv('MW_SERVER')` (full URL, e.g., `https://wiki.example.org`)
  - `$wgSitename = getenv('MW_SITENAME') ?: 'CaveWiki'`
  - `$wgScriptPath = ''`
- [x] Security keys:
  - `$wgSecretKey = getenv('MW_SECRET_KEY')`
  - `$wgUpgradeKey = getenv('MW_UPGRADE_KEY')`
- [x] Private wiki (all three set to `false` for the `'*'` group):
  - `$wgGroupPermissions['*']['read'] = false`
  - `$wgGroupPermissions['*']['edit'] = false`
  - `$wgGroupPermissions['*']['createaccount'] = false`
- [x] File uploads enabled, path = `/var/www/html/images` (EFS mount point)
- [x] Semantic MediaWiki: `enableSemantics( getenv('MW_SITENAME') ?: 'CaveWiki' )`

### origin-verify.conf (Apache config)

Rejects requests that don't carry the custom origin header. This ensures only the CloudFront distribution can reach the origin.

- [x] Read expected secret from `MW_ORIGIN_VERIFY` environment variable
- [x] Return 403 for any request where the `X-Origin-Verify` header is missing or doesn't match
- [x] Use Apache `<If>` directive (mod_headers + mod_expr)

### jobrunner.sh

- [x] Bash script that loops:
  1. Run `php maintenance/runJobs.php --wait --maxjobs=10`
  2. Sleep 5 seconds on empty queue
  3. Repeat indefinitely

### Phase 4 Success Criteria

- [x] `docker build docker/mediawiki/` completes successfully with no errors
- [x] Resulting image contains Semantic MediaWiki (`docker run --rm <image> composer --working-dir=/var/www/html show mediawiki/semantic-media-wiki` prints version)
- [x] `docker run --rm <image> composer --working-dir=/var/www/html show mediawiki/semantic-media-wiki` prints the installed version without errors
- [x] `docker run --rm <image> test -f /var/www/html/extensions/SemanticMediaWiki/extension.json` confirms extension files are in place
- [x] `LocalSettings.php` contains no hardcoded domain names, passwords, or environment-specific values
- [x] `jobrunner.sh` is executable in the built image
- [x] Image can start without crashing when env vars are provided (even if DB is unreachable — Apache should come up)

---

## Phase 5: Compute Stack — `cdk/lib/compute-stack.ts`

Depends on: NetworkStack, StorageStack. Requires Phase 4 Docker image files to exist in `docker/mediawiki/`.

### ECS Cluster & Task Definition

- [x] ECS Cluster (Fargate-only, no EC2 capacity providers)
- [x] Task Definition: 0.5 vCPU / 1024 MB
- [x] EFS volume definition referencing the EFS access point from StorageStack

#### Main container (`mediawiki`)

- [x] Image: `DockerImageAsset` from `docker/mediawiki/` (auto builds + pushes to CDK-managed ECR)
- [x] Port mapping: 80
- [x] Environment variables:
  - `MW_DB_HOST` — RDS instance endpoint
  - `MW_DB_NAME` — database name (default: `cavewiki`)
  - `MW_SERVER` — full public URL, constructed from `domainName` CDK context (e.g., `https://{domainName}`)
  - `MW_SITENAME` — wiki name (default: `CaveWiki`)
- [x] Secrets (injected from Secrets Manager / SSM):
  - `MW_DB_PASSWORD` — from RDS Secrets Manager secret (password field)
  - `MW_SECRET_KEY` — from SSM `/cavewiki/mediawiki-secret-key`
  - `MW_UPGRADE_KEY` — from SSM `/cavewiki/mediawiki-upgrade-key`
  - `MW_ORIGIN_VERIFY` — from SSM `/cavewiki/origin-verify-secret`
- [x] EFS volume mount at `/var/www/html/images`
- [x] Essential: true
- [x] Health check: `curl -f http://localhost/api.php`

#### Sidecar container (`jobrunner`)

- [x] Same image as main container
- [x] Override command: execute `jobrunner.sh`
- [x] Same environment variables and secrets as main container
- [x] Same EFS volume mount
- [x] Essential: false (web container survives if jobrunner crashes)
- [x] No port mappings

### ECS Service

- [x] Desired count: 1
- [x] Assign public IP: false (IPv6-only — no IPv4 address assigned)
- [x] Subnets: IPv6-only public subnets from NetworkStack
- [x] Security group: Fargate SG from NetworkStack
- [x] Enable ECS `dualStackIPv6` account setting for the account/region (`aws ecs put-account-setting --name dualStackIPv6 --value enabled`)

### Lambda DNS Updater — `cdk/lambda/dns-updater/index.ts`

- [x] Runtime: Node.js 20
- [x] Triggered by: EventBridge rule on any ECS task state change (cluster=this cluster)
- [x] Logic:
  1. List all RUNNING tasks in the cluster (`ecs:ListTasks`)
  2. Describe them all (`ecs:DescribeTasks`), filter to `healthStatus === 'HEALTHY'`
  3. Pick the newest healthy task by `startedAt` (handles rolling deploys correctly)
  4. Get the ENI attachment, call `ec2:DescribeNetworkInterfaces` for IPv6 — retry up to 3× with 5s backoff
  5. Call `route53:ChangeResourceRecordSets` to UPSERT an AAAA record
- [x] AAAA record config: `{originRecordName}.{hostedZoneName}`, TTL 60 seconds
- [x] IAM permissions (least-privilege):
  - `ecs:ListTasks` + `ecs:DescribeTasks` (scoped to cluster)
  - `ec2:DescribeNetworkInterfaces`
  - `route53:ChangeResourceRecordSets` (scoped to hosted zone)
- [x] Environment variables: `HOSTED_ZONE_ID`, `ORIGIN_RECORD_NAME`, `HOSTED_ZONE_NAME`

### CloudFront Distribution

- [x] Origin domain: `{originRecordName}.{hostedZoneName}` (the Route 53 AAAA record Lambda updates)
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
- [x] (The origin AAAA record is managed by the Lambda, not by CDK — CDK should not create it to avoid conflicts)

### Origin Chain Validation (gate — must pass before Phase 7)

After deploying the Compute stack, validate the full origin chain end-to-end before proceeding. This is the highest-risk piece of the architecture and should be proven early.

All tests below run from the devcontainer over IPv4 unless noted. DNS and CloudFront tests work without local IPv6 because CloudFront is dual-stack and DNS lookups for AAAA records travel over IPv4. Direct origin tests require IPv6 (use AWS CloudShell).

- [x] Fargate task reaches RUNNING state (`aws ecs list-tasks` returns a task ARN)
- [x] Lambda DNS updater fires (check CloudWatch Logs for the Lambda function)
- [x] Route 53 origin AAAA record is populated: `dig AAAA {originRecordName}.{hostedZoneName}` returns the Fargate task's IPv6 address
- [x] Origin header validation via debug instance (IPv6-only):
  - `curl -6` without header → 403 ✓
  - `curl -6 -H 'X-Origin-Verify: <secret>'` → 503 (origin chain works; 503 is SMW needing `install.php`/`update.php` — will become 200/302 after Phase 7 initial setup)
- [x] CloudFront chain responds: `curl -I https://{domainName}` returns a response via CloudFront (check `X-Cache` or `Server` header). This proves CloudFront → IPv6 origin → Apache is working end-to-end. ✓ (503 from PHP — expected pre-install; `server: Apache`, `via: CloudFront` confirm the chain)
- [x] Force a new deployment (task restart) and confirm the Lambda updates the AAAA record to the new IPv6 within ~60s

**If CloudFront fails** and you need to isolate whether it's DNS, IPv6 routing, or Apache: test each layer independently from CloudShell — check DNS resolution, direct IPv6 HTTP, and then CloudFront separately.

### Phase 5 Success Criteria

- [x] `npx cdk synth CaveWikiCompute` produces valid CloudFormation with no errors
- [x] Template contains ECS cluster, task definition (0.5 vCPU / 1024 MB), and ECS service (desired count 1)
- [x] Task definition has two containers: `mediawiki` (essential=true, port 80) and `jobrunner` (essential=false, no ports)
- [x] Task definition references EFS volume with the correct access point
- [x] Template contains Lambda function, EventBridge rule, and IAM role with scoped permissions
- [x] Template contains CloudFront distribution with CachingDisabled policy
- [x] All Origin Chain Validation checks above pass

---

## Phase 6: Deployment Scripts

### scripts/setup-secrets.sh

- [x] Creates SSM Parameter Store SecureString parameters (idempotent — skips if already exist):
  - `/cavewiki/mediawiki-secret-key` — 64-character random hex string
  - `/cavewiki/mediawiki-upgrade-key` — 16-character random hex string
  - `/cavewiki/origin-verify-secret` — 32-character random hex string (shared between CloudFront and Apache)
- [x] Uses `aws ssm put-parameter --type SecureString --no-overwrite`
- [x] Region: reads from `AWS_DEFAULT_REGION` or defaults to `us-west-2`

### scripts/deploy.sh

Environment variables are already available in the shell (sourced automatically by the devcontainer from the mounted secrets file — see `.devcontainer/on_create.sh`). The deploy script does **not** need to re-source them.

- [x] Validates required environment variables:
  - `CAVEWIKI_DOMAIN`
  - `CAVEWIKI_HOSTED_ZONE_ID`
  - `CAVEWIKI_HOSTED_ZONE_NAME`
  - `CAVEWIKI_CERTIFICATE_ARN`
- [x] Maps env vars to CDK `--context` flags
- [x] Runs `cd cdk && npx cdk deploy --all --require-approval never` (or with approval, adjustable)

### Phase 6 Success Criteria

- [x] `scripts/setup-secrets.sh` is executable and idempotent (running twice produces no errors, doesn't overwrite existing values)
- [x] After running `setup-secrets.sh`, `aws ssm get-parameter --name /cavewiki/mediawiki-secret-key` and `aws ssm get-parameter --name /cavewiki/mediawiki-upgrade-key` return valid parameters
- [x] `scripts/deploy.sh` is executable and exits with a clear error when any required env var (`CAVEWIKI_DOMAIN`, `CAVEWIKI_HOSTED_ZONE_ID`, `CAVEWIKI_HOSTED_ZONE_NAME`, `CAVEWIKI_CERTIFICATE_ARN`) is unset
- [x] `scripts/deploy.sh` passes all context values correctly (verify by running with `--dry-run` or checking the generated `cdk deploy` command)
- [x] Full deploy cycle completes: `./scripts/setup-secrets.sh && ./scripts/deploy.sh` runs end-to-end

---

## Phase 7: End-to-End Verification & Initial Setup

### Pre-Deploy Verification

- [x] `cd cdk && npx cdk synth` — all three CloudFormation templates synthesize without errors
- [x] `docker build docker/mediawiki/` — Docker image builds successfully

### Deploy

- [x] `./scripts/setup-secrets.sh` — SSM parameters created
- [x] `cd cdk && npx cdk bootstrap` — CDK bootstrap (first time only)
- [x] `./scripts/deploy.sh` — all three stacks deployed

### Post-Deploy Infrastructure Checks

- [x] All three stacks show CREATE_COMPLETE in CloudFormation console
- [x] Fargate task reaches RUNNING state (`aws ecs list-tasks` returns a task ARN)
- [x] Both containers (`mediawiki` and `jobrunner`) are running in the task (check ECS console task detail)
- [x] Route 53: origin AAAA record is populated with the Fargate task's IPv6 address (`dig AAAA {originRecordName}.{hostedZoneName}` returns an AAAA record)
- [x] CloudFront distribution status is "Deployed"
- [x] `curl -I https://{domainName}` returns a response via CloudFront (check `X-Cache` or `Server` header)

### Initial MediaWiki Installation

ECS Exec is not available in IPv6-only mode. Use `aws ecs run-task` with a command override to run setup commands in a one-off task (same task definition, same network config, custom command).

- [ ] Run `php maintenance/install.php` via one-off ECS `run-task` with command override (see IMPLEMENTATION.md for full command)
- [ ] Run `php maintenance/update.php --quick` via one-off ECS `run-task` (Semantic MediaWiki table setup)
- [ ] Verify initial admin user was created by `install.php`

### Functional Verification

- [ ] Browse to `https://{domainName}` — redirects to login page (not the wiki content)
- [ ] Log in with admin credentials — wiki main page loads
- [ ] In an incognito/private window, `https://{domainName}` shows only a login form (anonymous read blocked)
- [ ] Create a test page with Semantic MediaWiki annotations (e.g., `[[Has type::Page]]`) — page saves without errors
- [ ] Upload a test file — upload succeeds, file is accessible after upload
- [ ] Stop and restart the Fargate task (force new deployment) — after restart, the uploaded file and wiki content still exist (confirms EFS and RDS persistence)
- [ ] Check CloudWatch Logs: the `jobrunner` log stream shows job processing output (even if "no jobs" messages)

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
  3. Verify Route 53 origin AAAA record matches current Fargate IPv6
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

### Lambda Migration (Final Target)

- [ ] Create new compute stack using Lambda (Bref PHP runtime) + Function URL
- [ ] Swap EFS media storage for S3 with presigned URLs (upload POST, direct download)
- [ ] Separate scheduled Lambda for background jobs (`maintenance/runJobs.php`)
- [ ] Update CloudFront origin from Route 53 A record to Function URL domain
- [ ] Remove Fargate-specific resources (ECS cluster, service, task definition, Lambda DNS updater)

### Security Hardening

- [ ] Restrict Fargate SG inbound to CloudFront managed prefix list (`com.amazonaws.global.cloudfront.origin-facing`) in addition to the custom origin header (defense-in-depth)
- [ ] Review and restrict ECS Exec IAM permissions for production use

### Operational

- [ ] Enable AWS Backup for EFS (~$0.05/GB/mo)
- [ ] Set up CloudWatch alarms (RDS connections, Fargate health, EFS throughput)
- [ ] Consider Fargate Spot for additional cost savings (~70% discount, with interruption risk)
- [ ] Consider scheduled Fargate scaling (scale to 0 at night) if usage patterns allow
- [ ] Consider upgrading RDS instance class if performance is insufficient during active use
