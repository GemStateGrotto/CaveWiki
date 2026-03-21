# CaveWiki — Implementation TODO

Checklist for building out the PoC infrastructure. Each phase depends on the previous. Every phase includes success criteria that must pass before moving on.

---

## Phase 1: Project Scaffolding

- [ ] Initialize CDK TypeScript project in `cdk/` (`cdk init app --language typescript`)
- [ ] Create `docker/mediawiki/` directory
- [ ] Create `scripts/` directory
- [ ] Define CDK context keys in `cdk/cdk.json`:
  - `domainName` — public wiki URL hostname
  - `hostedZoneId` — Route 53 hosted zone ID
  - `hostedZoneName` — Route 53 hosted zone domain name
  - `certificateArn` — ACM certificate ARN (must be in us-east-1 for CloudFront)
  - `originRecordName` — subdomain for Fargate origin AAAA record (default: `origin`)
- [ ] Create `cdk/lib/config.ts` — reads CDK context values, validates required ones, provides defaults
- [ ] Create `scripts/deploy.sh` — maps environment variables (already present in shell) to `--context` flags, runs `cdk deploy --all`

### Phase 1 Success Criteria

- [ ] `cd cdk && npx tsc --noEmit` compiles with zero errors
- [ ] `cd cdk && npx cdk synth` produces a CloudFormation template (even if nearly empty) without errors
- [ ] `cdk/lib/config.ts` throws a clear error when a required context key is missing (test by running `npx cdk synth` without context values)
- [ ] `scripts/deploy.sh` is executable and exits with a clear error message when required env vars are unset
- [ ] Directory structure matches the repository layout in README.md

---

## Phase 2: Network Stack — `cdk/lib/network-stack.ts`

- [ ] VPC with 2 AZs, public subnets only, no NAT gateway
- [ ] Enable dual-stack: Amazon-provided IPv6 CIDR on VPC + IPv6 CIDR on each subnet
- [ ] Route table: `::/0` → Internet Gateway (IPv6 egress)
- [ ] Security Groups:
  - [ ] **Fargate SG**: inbound TCP 80 from `::/0` (IPv6 — CloudFront connects over IPv6; custom origin header validates requests)
  - [ ] **Aurora SG**: inbound TCP 3306 from Fargate SG only
  - [ ] **EFS SG**: inbound TCP 2049 from Fargate SG only
- [ ] Export VPC and all three security groups as stack outputs

### Phase 2 Success Criteria

- [ ] `npx cdk synth CaveWikiNetwork` produces valid CloudFormation with no errors
- [ ] Template contains exactly one VPC (with IPv6 CIDR), two public subnets (one per AZ, dual-stack), three security groups
- [ ] No NAT Gateway or NAT Instance resources appear in the synthesized template
- [ ] Security group ingress rules match spec: Fargate SG allows 80/tcp from `::/0`; Aurora SG allows 3306/tcp from Fargate SG; EFS SG allows 2049/tcp from Fargate SG
- [ ] `npx cdk deploy CaveWikiNetwork` succeeds and resources are visible in AWS Console

---

## Phase 3: Storage Stack — `cdk/lib/storage-stack.ts`

Depends on: NetworkStack

### Aurora Serverless v2

- [ ] Engine: Aurora MySQL 8.0 compatible
- [ ] Single writer instance (no reader)
- [ ] Min capacity: 0 ACU (scale-to-zero / auto-pause enabled)
- [ ] Max capacity: 1 ACU
- [ ] Placed in public subnets, NOT publicly accessible (SG-restricted to Fargate SG)
- [ ] Master credentials: CDK-generated, auto-stored in Secrets Manager (free for RDS-managed)
- [ ] Removal policy: RETAIN

### EFS

- [ ] Encrypted at rest
- [ ] Performance mode: General Purpose
- [ ] Throughput mode: Elastic (pay-per-use)
- [ ] Mount targets in each public subnet
- [ ] Access point: UID/GID 33 (www-data), root directory path `/mediawiki-images`
- [ ] Removal policy: RETAIN

### Exports

- [ ] Aurora cluster endpoint + port
- [ ] Secrets Manager secret ARN (for DB credentials)
- [ ] EFS file system ID + access point ID

### Phase 3 Success Criteria

- [ ] `npx cdk synth CaveWikiStorage` produces valid CloudFormation with no errors
- [ ] Template contains Aurora cluster with ServerlessV2ScalingConfiguration (min 0, max 1)
- [ ] Template contains EFS file system with Encrypted=true and an access point with PosixUser UID/GID 33
- [ ] Aurora and EFS resources have DeletionPolicy=Retain in the synthesized template
- [ ] `npx cdk deploy CaveWikiStorage` succeeds
- [ ] Aurora cluster visible in RDS console with status "Available" or "Paused" (auto-pause)
- [ ] Secrets Manager contains the auto-generated DB credentials secret
- [ ] EFS file system visible in EFS console with mount targets in both AZs

---

## Phase 4: Docker Image — `docker/mediawiki/`

### Dockerfile

- [ ] Base image: `mediawiki:1.41-apache`
- [ ] Install `curl` for health checks (if not already in base)
- [ ] Copy `composer.local.json` into the MediaWiki directory
- [ ] Run `composer update --no-dev` to install Semantic MediaWiki
- [ ] Verify Composer exits 0 and all SMW dependencies resolve without conflicts
- [ ] Copy `LocalSettings.php` into place
- [ ] Copy `origin-verify.conf` Apache config into `/etc/apache2/conf-enabled/`
- [ ] Copy `jobrunner.sh` and make it executable

### composer.local.json

- [ ] Require `mediawiki/semantic-media-wiki: ~4.x`

### LocalSettings.php

All configuration via `getenv()` — no hardcoded values.

- [ ] Database config:
  - `$wgDBserver = getenv('MW_DB_HOST')`
  - `$wgDBname = getenv('MW_DB_NAME') ?: 'cavewiki'`
  - `$wgDBpassword = getenv('MW_DB_PASSWORD')`
  - `$wgDBuser = 'admin'` (Aurora default master user)
  - `$wgDBtype = 'mysql'`
- [ ] Aurora scale-to-zero compatibility:
  - `$wgDBservers` array with `'connectTimeout' => 60` (handles 25-30s cold start resume)
- [ ] Site config:
  - `$wgServer = getenv('MW_SERVER')` (full URL, e.g., `https://wiki.example.org`)
  - `$wgSitename = getenv('MW_SITENAME') ?: 'CaveWiki'`
  - `$wgScriptPath = ''`
- [ ] Security keys:
  - `$wgSecretKey = getenv('MW_SECRET_KEY')`
  - `$wgUpgradeKey = getenv('MW_UPGRADE_KEY')`
- [ ] Private wiki (all three set to `false` for the `'*'` group):
  - `$wgGroupPermissions['*']['read'] = false`
  - `$wgGroupPermissions['*']['edit'] = false`
  - `$wgGroupPermissions['*']['createaccount'] = false`
- [ ] File uploads enabled, path = `/var/www/html/images` (EFS mount point)
- [ ] Semantic MediaWiki: `enableSemantics( getenv('MW_SITENAME') ?: 'CaveWiki' )`

### origin-verify.conf (Apache config)

Rejects requests that don't carry the custom origin header. This ensures only the CloudFront distribution can reach the origin.

- [ ] Read expected secret from `MW_ORIGIN_VERIFY` environment variable
- [ ] Return 403 for any request where the `X-Origin-Verify` header is missing or doesn't match
- [ ] Use Apache `<If>` directive (mod_headers + mod_expr)

### jobrunner.sh

- [ ] Bash script that loops:
  1. Run `php maintenance/runJobs.php --wait --maxjobs=10`
  2. Sleep 5 seconds on empty queue
  3. Repeat indefinitely

### Phase 4 Success Criteria

- [ ] `docker build docker/mediawiki/` completes successfully with no errors
- [ ] Resulting image contains Semantic MediaWiki (`docker run --rm <image> php -r "require '/var/www/html/extensions/SemanticMediaWiki/SemanticMediaWiki.php';"` exits 0)
- [ ] `docker run --rm <image> composer --working-dir=/var/www/html show mediawiki/semantic-media-wiki` prints the installed version without errors
- [ ] `docker run --rm <image> test -f /var/www/html/extensions/SemanticMediaWiki/SemanticMediaWiki.php` confirms extension files are in place
- [ ] `LocalSettings.php` contains no hardcoded domain names, passwords, or environment-specific values
- [ ] `jobrunner.sh` is executable in the built image
- [ ] Image can start without crashing when env vars are provided (even if DB is unreachable — Apache should come up)

---

## Phase 5: Compute Stack — `cdk/lib/compute-stack.ts`

Depends on: NetworkStack, StorageStack. Requires Phase 4 Docker image files to exist in `docker/mediawiki/`.

### ECS Cluster & Task Definition

- [ ] ECS Cluster (Fargate-only, no EC2 capacity providers)
- [ ] Task Definition: 0.5 vCPU / 1024 MB
- [ ] EFS volume definition referencing the EFS access point from StorageStack

#### Main container (`mediawiki`)

- [ ] Image: `DockerImageAsset` from `docker/mediawiki/` (auto builds + pushes to CDK-managed ECR)
- [ ] Port mapping: 80
- [ ] Environment variables:
  - `MW_DB_HOST` — Aurora cluster endpoint
  - `MW_DB_NAME` — database name (default: `cavewiki`)
  - `MW_SERVER` — full public URL, constructed from `domainName` CDK context (e.g., `https://{domainName}`)
  - `MW_SITENAME` — wiki name (default: `CaveWiki`)
- [ ] Secrets (injected from Secrets Manager / SSM):
  - `MW_DB_PASSWORD` — from Aurora Secrets Manager secret (password field)
  - `MW_SECRET_KEY` — from SSM `/cavewiki/mediawiki-secret-key`
  - `MW_UPGRADE_KEY` — from SSM `/cavewiki/mediawiki-upgrade-key`
  - `MW_ORIGIN_VERIFY` — from SSM `/cavewiki/origin-verify-secret`
- [ ] EFS volume mount at `/var/www/html/images`
- [ ] Essential: true
- [ ] Health check: `curl -f http://localhost/api.php`

#### Sidecar container (`jobrunner`)

- [ ] Same image as main container
- [ ] Override command: execute `jobrunner.sh`
- [ ] Same environment variables and secrets as main container
- [ ] Same EFS volume mount
- [ ] Essential: false (web container survives if jobrunner crashes)
- [ ] No port mappings

### ECS Service

- [ ] Desired count: 1
- [ ] Assign public IP: false (no public IPv4 — IPv6 used for public access; saves ~$3.60/mo)
- [ ] Subnets: public (dual-stack)
- [ ] Security group: Fargate SG from NetworkStack
- [ ] Enable Execute Command: true (for `ecs execute-command` to run install.php, update.php, etc.)

### Lambda DNS Updater — `cdk/lambda/dns-updater/index.ts`

- [ ] Runtime: Node.js 20
- [ ] Triggered by: EventBridge rule on ECS task state change (state=RUNNING, cluster=this cluster)
- [ ] Logic:
  1. Extract task ARN and cluster ARN from the EventBridge event
  2. Call `ecs:DescribeTasks` to get the ENI attachment
  3. Call `ec2:DescribeNetworkInterfaces` to get the IPv6 address — retry up to 3 times with 5s backoff if not yet assigned
  4. Call `route53:ChangeResourceRecordSets` to UPSERT an AAAA record
- [ ] AAAA record config: `{originRecordName}.{hostedZoneName}`, TTL 60 seconds
- [ ] IAM permissions (least-privilege):
  - `ecs:DescribeTasks` (scoped to cluster)
  - `ec2:DescribeNetworkInterfaces`
  - `route53:ChangeResourceRecordSets` (scoped to hosted zone)
- [ ] Environment variables: `HOSTED_ZONE_ID`, `ORIGIN_RECORD_NAME`, `HOSTED_ZONE_NAME`

### CloudFront Distribution

- [ ] Origin domain: `{originRecordName}.{hostedZoneName}` (the Route 53 AAAA record Lambda updates)
- [ ] Origin protocol policy: HTTP only (TLS terminates at CloudFront)
- [ ] Custom origin header: `X-Origin-Verify: <secret>` — value read from SSM `/cavewiki/origin-verify-secret`
- [ ] Cache policy: `CachePolicy.CACHING_DISABLED`
- [ ] Origin request policy: `OriginRequestPolicy.ALL_VIEWER` (forward all headers, cookies, query strings)
- [ ] Viewer protocol policy: Redirect HTTP → HTTPS
- [ ] Alternate domain names: `[domainName]` from CDK context
- [ ] Viewer certificate: ACM cert imported from ARN in CDK context (must be us-east-1)

### Route 53 Records

- [ ] Alias A + AAAA records: `domainName` → CloudFront distribution domain name
- [ ] (The origin AAAA record is managed by the Lambda, not by CDK — CDK should not create it to avoid conflicts)

### Origin Chain Validation (gate — must pass before Phase 7)

After deploying the Compute stack, validate the full origin chain end-to-end before proceeding. This is the highest-risk piece of the architecture and should be proven early.

All tests below run from the devcontainer over IPv4 unless noted. DNS and CloudFront tests work without local IPv6 because CloudFront is dual-stack and DNS lookups for AAAA records travel over IPv4.

- [ ] Fargate task reaches RUNNING state (`aws ecs list-tasks` returns a task ARN)
- [ ] Lambda DNS updater fires (check CloudWatch Logs for the Lambda function)
- [ ] Route 53 origin AAAA record is populated: `dig AAAA {originRecordName}.{hostedZoneName}` returns the Fargate task's IPv6 address
- [ ] Origin header validation via ECS Exec (localhost, no IPv6 needed):
  - `curl -I http://localhost/api.php` without header → 403
  - `curl -I -H 'X-Origin-Verify: <secret>' http://localhost/api.php` → 200/302
- [ ] CloudFront chain responds: `curl -I https://{domainName}` returns a response via CloudFront (check `X-Cache` or `Server` header). This proves CloudFront → IPv6 origin → Apache is working end-to-end.
- [ ] Force a new deployment (task restart) and confirm the Lambda updates the AAAA record to the new IPv6 within ~60s

**If CloudFront fails** and you need to isolate whether it's DNS, IPv6 routing, or Apache: use AWS CloudShell (which has IPv6) to test directly:

```bash
# From CloudShell:
curl -6 -I http://{originRecordName}.{hostedZoneName}               # expect 403 (no header)
curl -6 -I -H 'X-Origin-Verify: <secret>' http://{originRecordName}.{hostedZoneName}  # expect 200/302
```

### Phase 5 Success Criteria

- [ ] `npx cdk synth CaveWikiCompute` produces valid CloudFormation with no errors
- [ ] Template contains ECS cluster, task definition (0.5 vCPU / 1024 MB), and ECS service (desired count 1)
- [ ] Task definition has two containers: `mediawiki` (essential=true, port 80) and `jobrunner` (essential=false, no ports)
- [ ] Task definition references EFS volume with the correct access point
- [ ] Template contains Lambda function, EventBridge rule, and IAM role with scoped permissions
- [ ] Template contains CloudFront distribution with CachingDisabled policy
- [ ] All Origin Chain Validation checks above pass

---

## Phase 6: Deployment Scripts

### scripts/setup-secrets.sh

- [ ] Creates SSM Parameter Store SecureString parameters (idempotent — skips if already exist):
  - `/cavewiki/mediawiki-secret-key` — 64-character random hex string
  - `/cavewiki/mediawiki-upgrade-key` — 16-character random hex string
  - `/cavewiki/origin-verify-secret` — 32-character random hex string (shared between CloudFront and Apache)
- [ ] Uses `aws ssm put-parameter --type SecureString --no-overwrite`
- [ ] Region: reads from `AWS_DEFAULT_REGION` or defaults to `us-west-2`

### scripts/deploy.sh

Environment variables are already available in the shell (sourced automatically by the devcontainer from the mounted secrets file — see `.devcontainer/on_create.sh`). The deploy script does **not** need to re-source them.

- [ ] Validates required environment variables:
  - `CAVEWIKI_DOMAIN`
  - `CAVEWIKI_HOSTED_ZONE_ID`
  - `CAVEWIKI_HOSTED_ZONE_NAME`
  - `CAVEWIKI_CERTIFICATE_ARN`
- [ ] Maps env vars to CDK `--context` flags
- [ ] Runs `cd cdk && npx cdk deploy --all --require-approval never` (or with approval, adjustable)

### Phase 6 Success Criteria

- [ ] `scripts/setup-secrets.sh` is executable and idempotent (running twice produces no errors, doesn't overwrite existing values)
- [ ] After running `setup-secrets.sh`, `aws ssm get-parameter --name /cavewiki/mediawiki-secret-key` and `aws ssm get-parameter --name /cavewiki/mediawiki-upgrade-key` return valid parameters
- [ ] `scripts/deploy.sh` is executable and exits with a clear error when any required env var (`CAVEWIKI_DOMAIN`, `CAVEWIKI_HOSTED_ZONE_ID`, `CAVEWIKI_HOSTED_ZONE_NAME`, `CAVEWIKI_CERTIFICATE_ARN`) is unset
- [ ] `scripts/deploy.sh` passes all context values correctly (verify by running with `--dry-run` or checking the generated `cdk deploy` command)
- [ ] Full deploy cycle completes: `./scripts/setup-secrets.sh && ./scripts/deploy.sh` runs end-to-end

---

## Phase 7: End-to-End Verification & Initial Setup

### Pre-Deploy Verification

- [ ] `cd cdk && npx cdk synth` — all three CloudFormation templates synthesize without errors
- [ ] `docker build docker/mediawiki/` — Docker image builds successfully

### Deploy

- [ ] `./scripts/setup-secrets.sh` — SSM parameters created
- [ ] `cd cdk && npx cdk bootstrap` — CDK bootstrap (first time only)
- [ ] `./scripts/deploy.sh` — all three stacks deployed

### Post-Deploy Infrastructure Checks

- [ ] All three stacks show CREATE_COMPLETE in CloudFormation console
- [ ] Fargate task reaches RUNNING state (`aws ecs list-tasks` returns a task ARN)
- [ ] Both containers (`mediawiki` and `jobrunner`) are running in the task (check ECS console task detail)
- [ ] Route 53: origin AAAA record is populated with the Fargate task's IPv6 address (`dig AAAA {originRecordName}.{hostedZoneName}` returns an AAAA record)
- [ ] CloudFront distribution status is "Deployed"
- [ ] `curl -I https://{domainName}` returns a response via CloudFront (check `X-Cache` or `Server` header)

### Aurora Scale-to-Zero Validation

Validates that Aurora's auto-pause/resume behavior is compatible with the 60-second `connectTimeout` configured in `LocalSettings.php`. This can be performed by an agent via ECS Exec.

**Process:**

1. Confirm Aurora cluster is auto-paused: `aws rds describe-db-clusters --query 'DBClusters[?contains(DBClusterIdentifier, ``cavewiki``)].Status' --output text` should return `stopped` or show paused indicator
2. From the Fargate container (via ECS Exec), time a cold-start connection:
   ```
   time mysql -h "$MW_DB_HOST" -u admin -p"$MW_DB_PASSWORD" -e "SELECT 1"
   ```
3. If the connection does not succeed within 60 seconds, the wiki will show a timeout error on first request after Aurora pauses

- [ ] Aurora resumes and completes the connection within 60 seconds
- [ ] If resume exceeds 60s: increase `connectTimeout` in `LocalSettings.php` or disable auto-pause (set min ACU to 0.5 instead of 0)

### Initial MediaWiki Installation

- [ ] `aws ecs execute-command` into running Fargate task (confirms ECS Exec is working)
- [ ] Run `php maintenance/install.php` with DB credentials (see IMPLEMENTATION.md for full command)
- [ ] Run `php maintenance/update.php --quick` (Semantic MediaWiki table setup)
- [ ] Create initial admin user

### Functional Verification

- [ ] Browse to `https://{domainName}` — redirects to login page (not the wiki content)
- [ ] Log in with admin credentials — wiki main page loads
- [ ] In an incognito/private window, `https://{domainName}` shows only a login form (anonymous read blocked)
- [ ] Create a test page with Semantic MediaWiki annotations (e.g., `[[Has type::Page]]`) — page saves without errors
- [ ] Upload a test file — upload succeeds, file is accessible after upload
- [ ] Stop and restart the Fargate task (force new deployment) — after restart, the uploaded file and wiki content still exist (confirms EFS and Aurora persistence)
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
- [ ] Set up CloudWatch alarms (Aurora connections, Fargate health, EFS throughput)
- [ ] Consider Fargate Spot for additional cost savings (~70% discount, with interruption risk)
- [ ] Consider scheduled Fargate scaling (scale to 0 at night) if usage patterns allow
- [ ] Increase Aurora max ACU if performance is insufficient during active use
