#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { Od4EEcsCdkStack } from '../lib/od4e-ecs-cdk-stack';

const app = new cdk.App();
new Od4EEcsCdkStack(app, 'Od4EEcsCdkStack');
