import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  fargateSg: ec2.ISecurityGroup;
  dbSg: ec2.ISecurityGroup;
  efsSg: ec2.ISecurityGroup;
}

export class StorageStack extends cdk.Stack {
  public readonly dbInstance: rds.IDatabaseInstance;
  public readonly dbSecret: secretsmanager.ISecret;
  public readonly fileSystem: efs.IFileSystem;
  public readonly accessPoint: efs.IAccessPoint;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    // --- RDS MySQL 8.0 (db.t4g.micro) ---
    const instance = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [props.dbSg],
      credentials: rds.Credentials.fromGeneratedSecret('admin'),
      databaseName: 'cavewiki',
      networkType: rds.NetworkType.DUAL,
      publiclyAccessible: false,
      multiAz: false,
      allocatedStorage: 20,
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

    this.dbInstance = instance;
    this.dbSecret = instance.secret!;
    this.fileSystem = fileSystem;
    this.accessPoint = accessPoint;

    // Stack outputs
    new cdk.CfnOutput(this, 'DbEndpoint', {
      value: instance.instanceEndpoint.hostname,
    });
    new cdk.CfnOutput(this, 'DbPort', {
      value: instance.instanceEndpoint.port.toString(),
    });
    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: instance.secret!.secretArn,
    });
    new cdk.CfnOutput(this, 'EfsFileSystemId', {
      value: fileSystem.fileSystemId,
    });
    new cdk.CfnOutput(this, 'EfsAccessPointId', {
      value: accessPoint.accessPointId,
    });
  }
}
