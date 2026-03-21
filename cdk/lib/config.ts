import { App } from 'aws-cdk-lib/core';

export interface CaveWikiConfig {
  domainName: string;
  hostedZoneId: string;
  hostedZoneName: string;
  certificateArn: string;
  originRecordName: string;
}

export function loadConfig(app: App): CaveWikiConfig {
  const required = ['domainName', 'hostedZoneId', 'hostedZoneName', 'certificateArn'] as const;
  const missing = required.filter((key) => !app.node.tryGetContext(key));

  if (missing.length > 0) {
    throw new Error(
      `Missing required CDK context values: ${missing.join(', ')}. ` +
      'Pass them via --context flags or set them in cdk.json.',
    );
  }

  return {
    domainName: app.node.tryGetContext('domainName'),
    hostedZoneId: app.node.tryGetContext('hostedZoneId'),
    hostedZoneName: app.node.tryGetContext('hostedZoneName'),
    certificateArn: app.node.tryGetContext('certificateArn'),
    originRecordName: app.node.tryGetContext('originRecordName') || 'origin',
  };
}
