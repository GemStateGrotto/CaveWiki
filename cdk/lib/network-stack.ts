import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly fargateSg: ec2.ISecurityGroup;
  public readonly auroraSg: ec2.ISecurityGroup;
  public readonly efsSg: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipProtocol: ec2.IpProtocol.DUAL_STACK,
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          mapPublicIpOnLaunch: false,
        },
      ],
    });

    const fargateSg = new ec2.SecurityGroup(this, 'FargateSg', {
      vpc,
      description: 'Fargate service - allows HTTP from IPv6 internet (CloudFront)',
      allowAllOutbound: true,
      allowAllIpv6Outbound: true,
    });
    fargateSg.addIngressRule(
      ec2.Peer.anyIpv6(),
      ec2.Port.tcp(80),
      'HTTP from IPv6 (CloudFront)',
    );

    const auroraSg = new ec2.SecurityGroup(this, 'AuroraSg', {
      vpc,
      description: 'Aurora - allows MySQL from Fargate only',
      allowAllOutbound: false,
    });
    auroraSg.addIngressRule(
      fargateSg,
      ec2.Port.tcp(3306),
      'MySQL from Fargate',
    );

    const efsSg = new ec2.SecurityGroup(this, 'EfsSg', {
      vpc,
      description: 'EFS - allows NFS from Fargate only',
      allowAllOutbound: false,
    });
    efsSg.addIngressRule(
      fargateSg,
      ec2.Port.tcp(2049),
      'NFS from Fargate',
    );

    this.vpc = vpc;
    this.fargateSg = fargateSg;
    this.auroraSg = auroraSg;
    this.efsSg = efsSg;

    // Stack outputs
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'FargateSgId', { value: fargateSg.securityGroupId });
    new cdk.CfnOutput(this, 'AuroraSgId', { value: auroraSg.securityGroupId });
    new cdk.CfnOutput(this, 'EfsSgId', { value: efsSg.securityGroupId });
  }
}
