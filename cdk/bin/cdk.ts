#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { loadConfig } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { StorageStack } from '../lib/storage-stack';
import { ComputeStack } from '../lib/compute-stack';

const app = new cdk.App();

// Config validation — runs at synth time but not during bootstrap.
const config = loadConfig(app);

const network = new NetworkStack(app, 'CaveWikiNetwork');

const storage = new StorageStack(app, 'CaveWikiStorage', {
  vpc: network.vpc,
  fargateSg: network.fargateSg,
  auroraSg: network.auroraSg,
  efsSg: network.efsSg,
});

new ComputeStack(app, 'CaveWikiCompute', {
  vpc: network.vpc,
  ipv6OnlySubnets: network.ipv6OnlySubnets,
  fargateSg: network.fargateSg,
  auroraSg: network.auroraSg,
  efsSg: network.efsSg,
  dbCluster: storage.dbCluster,
  dbSecret: storage.dbSecret,
  fileSystem: storage.fileSystem,
  accessPoint: storage.accessPoint,
  config,
});

app.synth();
