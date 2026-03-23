import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  ecsSg: ec2.ISecurityGroup;
  efsSg: ec2.ISecurityGroup;
  /** AZ to pin the EBS volume to (must match EC2 instance AZ) */
  availabilityZone: string;
}

export class StorageStack extends cdk.Stack {
  public readonly fileSystem: efs.IFileSystem;
  public readonly accessPoint: efs.IAccessPoint;
  public readonly ebsVolume: ec2.IVolume;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    // --- EBS Volume (20 GB gp3, single AZ for SQLite) ---
    const volume = new ec2.Volume(this, 'DataVolume', {
      availabilityZone: props.availabilityZone,
      size: cdk.Size.gibibytes(20),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    cdk.Tags.of(volume).add('Name', 'CaveWiki-Data');
    cdk.Tags.of(volume).add('cavewiki:role', 'data');

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

    // Override mount targets to dual-stack so IPv6-only ECS tasks can reach EFS
    fileSystem.node.children
      .filter((c): c is efs.CfnMountTarget => c instanceof efs.CfnMountTarget)
      .forEach((mt) => { mt.ipAddressType = 'DUAL_STACK'; });

    const accessPoint = fileSystem.addAccessPoint('MediawikiImages', {
      path: '/mediawiki-images',
      posixUser: { uid: '33', gid: '33' },
      createAcl: { ownerUid: '33', ownerGid: '33', permissions: '755' },
    });

    this.fileSystem = fileSystem;
    this.accessPoint = accessPoint;
    this.ebsVolume = volume;

    // Stack outputs
    new cdk.CfnOutput(this, 'EbsVolumeId', {
      value: volume.volumeId,
    });
    new cdk.CfnOutput(this, 'EfsFileSystemId', {
      value: fileSystem.fileSystemId,
    });
    new cdk.CfnOutput(this, 'EfsAccessPointId', {
      value: accessPoint.accessPointId,
    });
  }
}
