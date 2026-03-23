import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import { Construct } from 'constructs';
import { CaveWikiConfig } from './config';

export interface ComputeStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  ipv6OnlySubnets: ec2.ISubnet[];
  ecsSg: ec2.ISecurityGroup;
  efsSg: ec2.ISecurityGroup;
  fileSystem: efs.IFileSystem;
  accessPoint: efs.IAccessPoint;
  ebsVolume: ec2.IVolume;
  config: CaveWikiConfig;
}

export class ComputeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const { vpc, ipv6OnlySubnets, ecsSg, efsSg, fileSystem, accessPoint, ebsVolume, config } = props;

    // --- SSM Parameters (read existing) ---
    const ssmSecretKey = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'SsmSecretKey', {
      parameterName: '/cavewiki/mediawiki-secret-key',
    });
    const ssmUpgradeKey = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'SsmUpgradeKey', {
      parameterName: '/cavewiki/mediawiki-upgrade-key',
    });
    const ssmOriginVerify = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'SsmOriginVerify', {
      parameterName: '/cavewiki/origin-verify-secret',
    });

    // --- ECS Cluster with EC2 capacity ---
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    // --- Docker Image Asset (ARM64 for t4g) ---
    const imageAsset = new ecr_assets.DockerImageAsset(this, 'MediawikiImage', {
      directory: path.join(__dirname, '..', '..', 'docker', 'mediawiki'),
      platform: ecr_assets.Platform.LINUX_ARM64,
    });

    // Dual-stack ECR URI so IPv6-only instances can pull over native IPv6
    const dualStackImageUri = `${this.account}.dkr-ecr.${this.region}.on.aws/${imageAsset.repository.repositoryName}:${imageAsset.imageTag}`;
    const mediawikiImage = ecs.ContainerImage.fromRegistry(dualStackImageUri);

    // --- EC2 Auto Scaling Group ---
    // Use the first IPv6-only subnet (single AZ — must match EBS volume)
    const instanceSubnet = ipv6OnlySubnets[0];

    const userData = ec2.UserData.forLinux();

    // 1. Configure ECS agent
    userData.addCommands(
      'mkdir -p /etc/ecs',
      `echo "ECS_CLUSTER=${cluster.clusterName}" >> /etc/ecs/ecs.config`,
      'echo "ECS_INSTANCE_IP_COMPATIBILITY=ipv6" >> /etc/ecs/ecs.config',
    );

    // 2. Configure SSM Agent for dual-stack endpoints (required in IPv6-only subnets)
    userData.addCommands(
      'mkdir -p /etc/amazon/ssm',
      `printf '{"Agent":{"Region":"${this.region}","UseDualStackEndpoint":true}}\\n' > /etc/amazon/ssm/amazon-ssm-agent.json`,
      'systemctl restart amazon-ssm-agent || true',
    );

    // 3. AWS CLI must use dual-stack endpoints (IPv6-only subnet)
    userData.addCommands(
      'export AWS_USE_DUALSTACK_ENDPOINT=true',
    );

    // 4. Attach EBS volume, format if needed, mount — terminate instance on failure
    userData.addCommands(
      'TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")',
      'INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)',
      `VOLUME_ID="${ebsVolume.volumeId}"`,
      `REGION="${this.region}"`,
      '',
      '# Retry attach — volume may still be attached to a terminating instance',
      'EBS_ATTACHED=false',
      'for ATTEMPT in $(seq 1 30); do',
      '  STATE=$(aws ec2 describe-volumes --volume-ids "$VOLUME_ID" --region "$REGION" --query "Volumes[0].State" --output text)',
      '  if [ "$STATE" = "available" ]; then',
      '    if aws ec2 attach-volume --volume-id "$VOLUME_ID" --instance-id "$INSTANCE_ID" --device /dev/xvdf --region "$REGION"; then',
      '      EBS_ATTACHED=true',
      '      break',
      '    fi',
      '  fi',
      '  echo "EBS volume state: $STATE — waiting (attempt $ATTEMPT/30)..."',
      '  sleep 10',
      'done',
      '',
      'if [ "$EBS_ATTACHED" != "true" ]; then',
      '  echo "FATAL: Failed to attach EBS volume after 5 minutes. Terminating instance."',
      '  aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION"',
      '  exit 1',
      'fi',
      '',
      '# Wait for the block device to appear (may show as NVMe on Nitro instances)',
      'BLOCK_DEV=""',
      'for i in $(seq 1 30); do',
      '  if [ -b /dev/xvdf ]; then BLOCK_DEV=/dev/xvdf; break; fi',
      '  NVME_DEV=$(lsblk -o NAME,SERIAL -dpn 2>/dev/null | grep "${VOLUME_ID//-/}" | awk \'{print $1}\')',
      '  if [ -n "$NVME_DEV" ] && [ -b "$NVME_DEV" ]; then BLOCK_DEV="$NVME_DEV"; break; fi',
      '  sleep 2',
      'done',
      '',
      'if [ -z "$BLOCK_DEV" ]; then',
      '  echo "FATAL: EBS block device never appeared. Terminating instance."',
      '  aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION"',
      '  exit 1',
      'fi',
      '',
      '# Format only if no filesystem exists',
      'blkid "$BLOCK_DEV" || mkfs.ext4 "$BLOCK_DEV"',
      '',
      'mkdir -p /mnt/data',
      'if ! mount "$BLOCK_DEV" /mnt/data; then',
      '  echo "FATAL: Failed to mount EBS volume. Terminating instance."',
      '  aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION"',
      '  exit 1',
      'fi',
      '',
      '# SQLite directory owned by www-data (UID 33)',
      'mkdir -p /mnt/data/sqlite',
      'chown 33:33 /mnt/data/sqlite',
    );

    // 5. Update Route 53 AAAA record with this instance's IPv6
    userData.addCommands(
      'IPV6_ADDR=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/ipv6)',
      '',
      `printf '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"${config.originRecordName}.${config.hostedZoneName}","Type":"AAAA","TTL":60,"ResourceRecords":[{"Value":"%s"}]}}]}' "$IPV6_ADDR" > /tmp/r53-change.json`,
      `aws route53 change-resource-record-sets --hosted-zone-id "${config.hostedZoneId}" --region "${this.region}" --change-batch file:///tmp/r53-change.json`,
    );

    // ECS-optimized Amazon Linux 2023 ARM AMI
    const machineImage = ecs.EcsOptimizedImage.amazonLinux2023(ecs.AmiHardwareType.ARM);

    const asg = new autoscaling.AutoScalingGroup(this, 'Asg', {
      vpc,
      vpcSubnets: { subnets: [instanceSubnet] },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      machineImage,
      securityGroup: ecsSg,
      minCapacity: 0,
      maxCapacity: 1,
      desiredCapacity: 1,
      userData,
      ssmSessionPermissions: true,
    });

    // IAM permissions for EC2 instance: EBS attach + Route 53 update
    asg.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:AttachVolume', 'ec2:DescribeVolumes'],
      resources: ['*'],
    }));
    asg.addToRolePolicy(new iam.PolicyStatement({
      actions: ['route53:ChangeResourceRecordSets'],
      resources: [`arn:aws:route53:::hostedzone/${config.hostedZoneId}`],
    }));

    // Add EC2 capacity provider to cluster
    const capacityProvider = new ecs.AsgCapacityProvider(this, 'AsgCapacityProvider', {
      autoScalingGroup: asg,
      enableManagedTerminationProtection: false,
    });
    cluster.addAsgCapacityProvider(capacityProvider);

    // --- Task Definition (EC2, host network mode) ---
    const taskDef = new ecs.Ec2TaskDefinition(this, 'TaskDef', {
      networkMode: ecs.NetworkMode.HOST,
    });

    // EFS volume
    taskDef.addVolume({
      name: 'efs-images',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: 'ENABLED',
        },
      },
    });

    // EBS bind mount (host path → container)
    taskDef.addVolume({
      name: 'ebs-sqlite',
      host: { sourcePath: '/mnt/data/sqlite' },
    });

    // Grant task role access to EFS
    fileSystem.grant(taskDef.taskRole, 'elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite');

    // --- Main container (mediawiki) ---
    const mediawikiContainer = taskDef.addContainer('mediawiki', {
      image: mediawikiImage,
      essential: true,
      portMappings: [{ containerPort: 80, hostPort: 80 }],
      memoryReservationMiB: 512,
      environment: {
        MW_SERVER: `https://${config.domainName}`,
        MW_SITENAME: 'CaveWiki',
      },
      secrets: {
        MW_SECRET_KEY: ecs.Secret.fromSsmParameter(ssmSecretKey),
        MW_UPGRADE_KEY: ecs.Secret.fromSsmParameter(ssmUpgradeKey),
        MW_ORIGIN_VERIFY: ecs.Secret.fromSsmParameter(ssmOriginVerify),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -s -o /dev/null http://localhost/api.php || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'mediawiki',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    });

    mediawikiContainer.addMountPoints(
      {
        sourceVolume: 'efs-images',
        containerPath: '/var/www/html/images',
        readOnly: false,
      },
      {
        sourceVolume: 'ebs-sqlite',
        containerPath: '/var/www/html/data',
        readOnly: false,
      },
    );

    // --- Sidecar container (jobrunner) ---
    const jobrunnerContainer = taskDef.addContainer('jobrunner', {
      image: mediawikiImage,
      essential: false,
      command: ['/usr/local/bin/jobrunner.sh'],
      memoryReservationMiB: 128,
      environment: {
        MW_SERVER: `https://${config.domainName}`,
        MW_SITENAME: 'CaveWiki',
      },
      secrets: {
        MW_SECRET_KEY: ecs.Secret.fromSsmParameter(ssmSecretKey),
        MW_UPGRADE_KEY: ecs.Secret.fromSsmParameter(ssmUpgradeKey),
        MW_ORIGIN_VERIFY: ecs.Secret.fromSsmParameter(ssmOriginVerify),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'jobrunner',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    });

    jobrunnerContainer.addMountPoints(
      {
        sourceVolume: 'efs-images',
        containerPath: '/var/www/html/images',
        readOnly: false,
      },
      {
        sourceVolume: 'ebs-sqlite',
        containerPath: '/var/www/html/data',
        readOnly: false,
      },
    );

    // Grant ECR pull to the execution role (needed since we use fromRegistry
    // with the dual-stack URI instead of fromDockerImageAsset which auto-grants).
    imageAsset.repository.grantPull(taskDef.executionRole!);

    // --- ECS Service (EC2 capacity) ---
    const service = new ecs.Ec2Service(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });

    // --- Resolve origin verify secret for CloudFront ---
    const originVerifyLookup = new cr.AwsCustomResource(this, 'OriginVerifyLookup', {
      onUpdate: {
        service: 'SSM',
        action: 'GetParameter',
        parameters: {
          Name: '/cavewiki/origin-verify-secret',
          WithDecryption: true,
        },
        physicalResourceId: cr.PhysicalResourceId.of('origin-verify-secret'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [
            cdk.Arn.format({ service: 'ssm', resource: 'parameter', resourceName: 'cavewiki/origin-verify-secret' }, this),
          ],
        }),
        new iam.PolicyStatement({
          actions: ['kms:Decrypt'],
          resources: ['*'],
        }),
      ]),
    });
    const originVerifyValue = originVerifyLookup.getResponseField('Parameter.Value');

    // --- CloudFront Distribution ---
    const originFqdn = `${config.originRecordName}.${config.hostedZoneName}`;

    const certificate = acm.Certificate.fromCertificateArn(
      this, 'ViewerCert', config.certificateArn,
    );

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(originFqdn, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          ipAddressType: cloudfront.OriginIpAddressType.IPV6,
          customHeaders: {
            'X-Origin-Verify': originVerifyValue,
          },
        }),
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
      domainNames: [config.domainName],
      certificate,
    });

    // --- Route 53 Records (public domain → CloudFront) ---
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: config.hostedZoneId,
      zoneName: config.hostedZoneName,
    });

    new route53.ARecord(this, 'AliasA', {
      zone: hostedZone,
      recordName: config.domainName,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });

    new route53.AaaaRecord(this, 'AliasAAAA', {
      zone: hostedZone,
      recordName: config.domainName,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });

    // Stack outputs
    new cdk.CfnOutput(this, 'ClusterArn', { value: cluster.clusterArn });
    new cdk.CfnOutput(this, 'ServiceName', { value: service.serviceName });
    new cdk.CfnOutput(this, 'DistributionDomainName', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
  }
}
