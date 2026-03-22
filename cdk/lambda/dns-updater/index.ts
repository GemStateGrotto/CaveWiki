import { ECSClient, DescribeTasksCommand, ListTasksCommand } from '@aws-sdk/client-ecs';
import { EC2Client, DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';
import { Route53Client, ChangeResourceRecordSetsCommand } from '@aws-sdk/client-route-53';

const ecs = new ECSClient({});
const ec2 = new EC2Client({});
const r53 = new Route53Client({});

const HOSTED_ZONE_ID = process.env.HOSTED_ZONE_ID!;
const ORIGIN_RECORD_NAME = process.env.ORIGIN_RECORD_NAME!;
const HOSTED_ZONE_NAME = process.env.HOSTED_ZONE_NAME!;

interface EcsTaskStateChangeEvent {
  detail: {
    taskArn: string;
    clusterArn: string;
    lastStatus: string;
    attachments?: Array<{
      type: string;
      status: string;
      details?: Array<{ name: string; value: string }>;
    }>;
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handler(event: EcsTaskStateChangeEvent): Promise<void> {
  const { taskArn, clusterArn } = event.detail;
  console.log(`Task state change: ${taskArn} in cluster ${clusterArn}`);

  // During rolling deployments, multiple tasks emit RUNNING events.
  // Always resolve the newest RUNNING task to avoid stale AAAA records.
  const listResult = await ecs.send(
    new ListTasksCommand({ cluster: clusterArn, desiredStatus: 'RUNNING' }),
  );
  const runningTaskArns = listResult.taskArns ?? [];
  if (runningTaskArns.length === 0) {
    console.log('No running tasks found');
    return;
  }

  const describeResult = await ecs.send(
    new DescribeTasksCommand({ cluster: clusterArn, tasks: runningTaskArns }),
  );
  const tasks = describeResult.tasks ?? [];
  if (tasks.length === 0) {
    console.error('DescribeTasks returned no tasks');
    return;
  }

  // Prefer healthy tasks; fall back to newest running task if none are healthy yet
  // (happens on fresh start before the first health check passes).
  const healthyTasks = tasks.filter((t) => t.healthStatus === 'HEALTHY');
  const candidates = healthyTasks.length > 0 ? healthyTasks : tasks;

  // Pick the candidate that started most recently
  const task = candidates.reduce((newest, t) =>
    (t.startedAt ?? 0) > (newest.startedAt ?? 0) ? t : newest,
  );
  console.log(`Newest running task: ${task.taskArn} (started ${task.startedAt})`);

  // Find the ENI attachment
  const eniAttachment = task.attachments?.find((a) => a.type === 'ElasticNetworkInterface');
  const eniId = eniAttachment?.details?.find((d) => d.name === 'networkInterfaceId')?.value;
  if (!eniId) {
    console.error('No ENI found on task');
    return;
  }

  console.log(`Found ENI: ${eniId}`);

  // Get IPv6 address with retries (may not be assigned immediately)
  let ipv6Address: string | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const eniResult = await ec2.send(
      new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eniId] }),
    );
    const eni = eniResult.NetworkInterfaces?.[0];
    ipv6Address = eni?.Ipv6Addresses?.[0]?.Ipv6Address;

    if (ipv6Address) {
      break;
    }
    console.log(`IPv6 not yet assigned (attempt ${attempt}/3), waiting 5s...`);
    await sleep(5000);
  }

  if (!ipv6Address) {
    console.error('IPv6 address not assigned after 3 attempts');
    return;
  }

  console.log(`IPv6 address: ${ipv6Address}`);

  // UPSERT the AAAA record
  const fqdn = `${ORIGIN_RECORD_NAME}.${HOSTED_ZONE_NAME}`;
  await r53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: HOSTED_ZONE_ID,
      ChangeBatch: {
        Changes: [
          {
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: fqdn,
              Type: 'AAAA',
              TTL: 60,
              ResourceRecords: [{ Value: ipv6Address }],
            },
          },
        ],
      },
    }),
  );

  console.log(`Updated AAAA record: ${fqdn} -> ${ipv6Address}`);
}
