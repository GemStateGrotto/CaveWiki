import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  fargateSg: ec2.ISecurityGroup;
  auroraSg: ec2.ISecurityGroup;
  efsSg: ec2.ISecurityGroup;
}

export class StorageStack extends cdk.Stack {
  public readonly dbCluster: rds.IDatabaseCluster;
  public readonly dbSecret: secretsmanager.ISecret;
  public readonly fileSystem: efs.IFileSystem;
  public readonly accessPoint: efs.IAccessPoint;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    // --- Aurora Serverless v2 (MySQL 8.0) ---
    const cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_08_0,
      }),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 1,
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        publiclyAccessible: false,
      }),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [props.auroraSg],
      credentials: rds.Credentials.fromGeneratedSecret('admin'),
      defaultDatabaseName: 'cavewiki',
      networkType: rds.NetworkType.DUAL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --- EFS ---
    const fileSystem = new efs.FileSystem(this, 'Efs', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: props.efsSg,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.ELASTIC,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Override mount targets to dual-stack so IPv6-only Fargate tasks can reach EFS
    fileSystem.node.children
      .filter((c): c is efs.CfnMountTarget => c instanceof efs.CfnMountTarget)
      .forEach((mt) => { mt.ipAddressType = 'DUAL_STACK'; });

    const accessPoint = fileSystem.addAccessPoint('MediawikiImages', {
      path: '/mediawiki-images',
      posixUser: { uid: '33', gid: '33' },
      createAcl: { ownerUid: '33', ownerGid: '33', permissions: '755' },
    });

    this.dbCluster = cluster;
    this.dbSecret = cluster.secret!;
    this.fileSystem = fileSystem;
    this.accessPoint = accessPoint;

    // Stack outputs
    new cdk.CfnOutput(this, 'AuroraClusterEndpoint', {
      value: cluster.clusterEndpoint.hostname,
    });
    new cdk.CfnOutput(this, 'AuroraClusterPort', {
      value: cluster.clusterEndpoint.port.toString(),
    });
    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: cluster.secret!.secretArn,
    });
    new cdk.CfnOutput(this, 'EfsFileSystemId', {
      value: fileSystem.fileSystemId,
    });
    new cdk.CfnOutput(this, 'EfsAccessPointId', {
      value: accessPoint.accessPointId,
    });
  }
}
