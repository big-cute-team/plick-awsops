#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsopsStack } from '../lib/awsops-stack';
import { AgentCoreStack } from '../lib/agentcore-stack';

const app = new cdk.App();

// CMDB 필수 태그 — 모든 스택의 태깅 가능한 리소스에 전파됨
cdk.Tags.of(app).add('Realm', 'awsops');
cdk.Tags.of(app).add('ServiceDomain', 'aws');
cdk.Tags.of(app).add('ServiceComponent', 'awsops-poc');
cdk.Tags.of(app).add('Environment', 'sandbox');

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-2',
};

// Main infrastructure stack: VPC, ALB, EC2, CloudFront, SSM endpoints
const infra = new AwsopsStack(app, 'AwsopsStack', {
  env,
  description: 'AWSops Dashboard - VPC, ALB, EC2, CloudFront infrastructure',
});

// Cognito 인증: CloudFront/Lambda@Edge 대신 ALB authenticate-cognito 사용
// (SCP가 CloudFront 생성을 차단) — User Pool 생성과 리스너 부착은 05-setup-cognito.sh가 수행

// AgentCore AI stack (placeholder)
const agentCore = new AgentCoreStack(app, 'AwsopsAgentCoreStack', {
  env,
  description: 'AWSops Dashboard - Bedrock AgentCore Runtime and Gateway',
});
agentCore.addDependency(infra);

app.synth();
