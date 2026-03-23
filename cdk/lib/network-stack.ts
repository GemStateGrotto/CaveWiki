import * as cdk from 'aws-cdk-lib/core';
import { Fn } from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly ipv6OnlySubnets: ec2.ISubnet[];
  public readonly ecsSg: ec2.ISecurityGroup;
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

    // --- IPv6-only public subnets for ECS EC2 (no IPv4 CIDR) ---
    const igw = vpc.node.findChild('IGW') as ec2.CfnInternetGateway;
    const vpcGw = vpc.node.findChild('VPCGW') as ec2.CfnVPCGatewayAttachment;
    const ipv6CidrBlock = Fn.select(0, vpc.vpcIpv6CidrBlocks);
    const azs = cdk.Stack.of(this).availabilityZones;

    const ipv6OnlySubnets: ec2.ISubnet[] = [];
    for (let i = 0; i < 2; i++) {
      const cfnSubnet = new ec2.CfnSubnet(this, `Ipv6OnlySubnet${i + 1}`, {
        vpcId: vpc.vpcId,
        availabilityZone: azs[i],
        ipv6Native: true,
        ipv6CidrBlock: Fn.select(i + 2, Fn.cidr(ipv6CidrBlock, 256, '64')),
        assignIpv6AddressOnCreation: true,
        enableDns64: true,
        mapPublicIpOnLaunch: false,
        tags: [{ key: 'Name', value: `CaveWikiNetwork/Ipv6OnlySubnet${i + 1}` }],
      });

      const routeTable = new ec2.CfnRouteTable(this, `Ipv6OnlyRT${i + 1}`, {
        vpcId: vpc.vpcId,
        tags: [{ key: 'Name', value: `CaveWikiNetwork/Ipv6OnlyRT${i + 1}` }],
      });

      new ec2.CfnRoute(this, `Ipv6OnlyDefaultRoute${i + 1}`, {
        routeTableId: routeTable.ref,
        destinationIpv6CidrBlock: '::/0',
        gatewayId: igw.ref,
      }).addDependency(vpcGw);

      new ec2.CfnSubnetRouteTableAssociation(this, `Ipv6OnlyRTAssoc${i + 1}`, {
        subnetId: cfnSubnet.ref,
        routeTableId: routeTable.ref,
      });

      ipv6OnlySubnets.push(
        ec2.Subnet.fromSubnetAttributes(this, `Ipv6OnlySubnetRef${i + 1}`, {
          subnetId: cfnSubnet.ref,
          availabilityZone: azs[i],
          routeTableId: routeTable.ref,
        }),
      );
    }

    // ECS SG: allows HTTP from IPv6 internet (CloudFront connects over IPv6)
    // Keep the logical ID 'FargateSg' for CloudFormation compatibility with the deployed stack
    const ecsSg = new ec2.SecurityGroup(this, 'FargateSg', {
      vpc,
      description: 'ECS service - allows HTTP from IPv6 internet (CloudFront)',
      allowAllOutbound: true,
      allowAllIpv6Outbound: true,
    });
    ecsSg.addIngressRule(
      ec2.Peer.anyIpv6(),
      ec2.Port.tcp(80),
      'HTTP from IPv6 (CloudFront)',
    );

    const efsSg = new ec2.SecurityGroup(this, 'EfsSg', {
      vpc,
      description: 'EFS - allows NFS from ECS only',
      allowAllOutbound: false,
    });
    efsSg.addIngressRule(
      ecsSg,
      ec2.Port.tcp(2049),
      'NFS from ECS',
    );

    this.vpc = vpc;
    this.ipv6OnlySubnets = ipv6OnlySubnets;
    this.ecsSg = ecsSg;
    this.efsSg = efsSg;

    // Stack outputs
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'EcsSgId', { value: ecsSg.securityGroupId });
    new cdk.CfnOutput(this, 'EfsSgId', { value: efsSg.securityGroupId });
  }
}
