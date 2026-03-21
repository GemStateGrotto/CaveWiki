import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { CaveWikiConfig } from './config';

export interface ComputeStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  fargateSg: ec2.ISecurityGroup;
  dbCluster: rds.IDatabaseCluster;
  dbSecret: secretsmanager.ISecret;
  fileSystem: efs.IFileSystem;
  accessPoint: efs.IAccessPoint;
  config: CaveWikiConfig;
}

export class ComputeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const { vpc, fargateSg, dbCluster, dbSecret, fileSystem, accessPoint, config } = props;

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

    // --- ECS Cluster ---
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    // --- Docker Image Asset ---
    const imageAsset = new ecr_assets.DockerImageAsset(this, 'MediawikiImage', {
      directory: path.join(__dirname, '..', '..', 'docker', 'mediawiki'),
    });

    // --- Task Definition ---
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
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

    // Grant task role access to EFS
    fileSystem.grant(taskDef.taskRole, 'elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite');

    // --- Main container (mediawiki) ---
    const mediawikiContainer = taskDef.addContainer('mediawiki', {
      image: ecs.ContainerImage.fromDockerImageAsset(imageAsset),
      essential: true,
      portMappings: [{ containerPort: 80 }],
      environment: {
        MW_DB_HOST: dbCluster.clusterEndpoint.hostname,
        MW_DB_NAME: 'cavewiki',
        MW_SERVER: `https://${config.domainName}`,
        MW_SITENAME: 'CaveWiki',
      },
      secrets: {
        MW_DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
        MW_SECRET_KEY: ecs.Secret.fromSsmParameter(ssmSecretKey),
        MW_UPGRADE_KEY: ecs.Secret.fromSsmParameter(ssmUpgradeKey),
        MW_ORIGIN_VERIFY: ecs.Secret.fromSsmParameter(ssmOriginVerify),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost/api.php || exit 1'],
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

    mediawikiContainer.addMountPoints({
      sourceVolume: 'efs-images',
      containerPath: '/var/www/html/images',
      readOnly: false,
    });

    // --- Sidecar container (jobrunner) ---
    const jobrunnerContainer = taskDef.addContainer('jobrunner', {
      image: ecs.ContainerImage.fromDockerImageAsset(imageAsset),
      essential: false,
      command: ['/usr/local/bin/jobrunner.sh'],
      environment: {
        MW_DB_HOST: dbCluster.clusterEndpoint.hostname,
        MW_DB_NAME: 'cavewiki',
        MW_SERVER: `https://${config.domainName}`,
        MW_SITENAME: 'CaveWiki',
      },
      secrets: {
        MW_DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
        MW_SECRET_KEY: ecs.Secret.fromSsmParameter(ssmSecretKey),
        MW_UPGRADE_KEY: ecs.Secret.fromSsmParameter(ssmUpgradeKey),
        MW_ORIGIN_VERIFY: ecs.Secret.fromSsmParameter(ssmOriginVerify),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'jobrunner',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    });

    jobrunnerContainer.addMountPoints({
      sourceVolume: 'efs-images',
      containerPath: '/var/www/html/images',
      readOnly: false,
    });

    // --- ECS Service ---
    // assignPublicIp must be true: the ECS agent resolves AWS service endpoints
    // (SSM, Secrets Manager, ECR, CloudWatch) over IPv4. Without a public IPv4 or
    // NAT, secret injection and image pull fail with "context deadline exceeded".
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [fargateSg],
      enableExecuteCommand: true,
    });

    // --- Lambda DNS Updater ---
    const dnsUpdater = new lambdaNode.NodejsFunction(this, 'DnsUpdater', {
      entry: path.join(__dirname, '..', 'lambda', 'dns-updater', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        HOSTED_ZONE_ID: config.hostedZoneId,
        ORIGIN_RECORD_NAME: config.originRecordName,
        HOSTED_ZONE_NAME: config.hostedZoneName,
      },
    });

    // IAM permissions for Lambda (least-privilege)
    dnsUpdater.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:DescribeTasks'],
        resources: ['*'],
        conditions: {
          ArnEquals: { 'ecs:cluster': cluster.clusterArn },
        },
      }),
    );
    dnsUpdater.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeNetworkInterfaces'],
        resources: ['*'],
      }),
    );
    dnsUpdater.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [`arn:aws:route53:::hostedzone/${config.hostedZoneId}`],
      }),
    );

    // EventBridge rule: ECS task state change → RUNNING
    const rule = new events.Rule(this, 'TaskRunningRule', {
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          clusterArn: [cluster.clusterArn],
          lastStatus: ['RUNNING'],
        },
      },
    });
    rule.addTarget(new targets.LambdaFunction(dnsUpdater));

    // --- Resolve origin verify secret for CloudFront (SecureString not supported as dynamic ref) ---
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
