// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Construct } from 'constructs';
import {
  Duration,
  aws_lambda,
  aws_opensearchservice,
  aws_dynamodb,
  aws_logs,
  aws_iam,
  Stack,
} from 'aws-cdk-lib';
import { HttpApi, HttpMethod, CorsHttpMethod } from '@aws-cdk/aws-apigatewayv2-alpha';
import { HttpLambdaIntegration } from '@aws-cdk/aws-apigatewayv2-integrations-alpha';
import { HttpIamAuthorizer } from '@aws-cdk/aws-apigatewayv2-authorizers-alpha';

interface ApiProps {
  accessRole: aws_iam.IRole;
  openSearchDomain: aws_opensearchservice.Domain;
  openSearchRole: aws_iam.Role;
  productsTable: aws_dynamodb.Table;
  countTable: aws_dynamodb.Table;
}

export class Api extends Construct {
  httpApi: HttpApi;

  constructor(scope: Construct, name: string, props: ApiProps) {
    super(scope, name);
    const { openSearchDomain, openSearchRole, productsTable, countTable, accessRole } = props;

    const authorizer = new HttpIamAuthorizer();

    const httpApi = new HttpApi(this, 'HttpApi', {
      apiName: 'subs',
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowHeaders: ['*'],
        allowOrigins: ['*'],
        allowMethods: [CorsHttpMethod.ANY],
      },
    });

    const accessLogGroup = new aws_logs.LogGroup(this, 'APIGW-AccessLogs');
    const stage = httpApi.defaultStage!.node.defaultChild as any;
    stage.accessLogSettings = {
      destinationArn: accessLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        userAgent: '$context.identity.userAgent',
        sourceIp: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        requestTimeEpoch: '$context.requestTimeEpoch',
        httpMethod: '$context.httpMethod',
        path: '$context.path',
        status: '$context.status',
        protocol: '$context.protocol',
        responseLength: '$context.responseLength',
        domainName: '$context.domainName',
      }),
    };
    accessLogGroup.grantWrite(new aws_iam.ServicePrincipal('apigateway.amazonaws.com'));

    const productsFn = new aws_lambda.DockerImageFunction(this, 'ProductsApiLambda', {
      code: aws_lambda.DockerImageCode.fromImageAsset('lib/api/lambdas/products'),
      architecture:
        process.arch === 'arm64' ? aws_lambda.Architecture.ARM_64 : aws_lambda.Architecture.X86_64,
      environment: {
        region: Stack.of(this).region,
        host: openSearchDomain.domainEndpoint,
      },
      role: openSearchRole,
      timeout: Duration.minutes(1),
    });

    const subsFn = new aws_lambda.DockerImageFunction(this, 'SubsApiLambda', {
      code: aws_lambda.DockerImageCode.fromImageAsset('lib/api/lambdas/substitutions'),
      architecture:
        process.arch === 'arm64' ? aws_lambda.Architecture.ARM_64 : aws_lambda.Architecture.X86_64,
      environment: {
        region: Stack.of(this).region,
        host: openSearchDomain.domainEndpoint,
      },
      role: openSearchRole,
      timeout: Duration.minutes(1),
    });

    const addProductFn = new aws_lambda.Function(this, 'AddProductLambda', {
      code: aws_lambda.Code.fromAsset('lib/api/lambdas/add-product'),
      environment: {
        tableName: productsTable.tableName,
      },
      timeout: Duration.minutes(1),
      runtime: aws_lambda.Runtime.PYTHON_3_8,
      handler: 'index.handler',
    });

    const statusFn = new aws_lambda.DockerImageFunction(this, 'StatusLambda', {
      code: aws_lambda.DockerImageCode.fromImageAsset('lib/api/lambdas/status'),
      environment: {
        host: openSearchDomain.domainEndpoint,
        tableName: countTable.tableName,
        region: Stack.of(this).region,
      },
      role: openSearchRole,
      timeout: Duration.minutes(15),
    });
    countTable.grantReadData(statusFn);
    productsTable.grantReadData(statusFn);

    const productsIntegration = new HttpLambdaIntegration('ProductsIntegration', productsFn);
    const subsIntegration = new HttpLambdaIntegration('SubsIntegration', subsFn);
    const addIntegration = new HttpLambdaIntegration('AddProductIntegration', addProductFn);
    const statusIntegration = new HttpLambdaIntegration('StatusIntegration', statusFn, {});

    const [productsRoute] = httpApi.addRoutes({
      path: '/products',
      methods: [HttpMethod.GET],
      integration: productsIntegration,
    });
    productsRoute.grantInvoke(accessRole);

    const [subsRoute] = httpApi.addRoutes({
      path: '/substitutions',
      methods: [HttpMethod.GET],
      integration: subsIntegration,
    });
    subsRoute.grantInvoke(accessRole);

    const [addRoute] = httpApi.addRoutes({
      path: '/add-product',
      methods: [HttpMethod.POST],
      integration: addIntegration,
    });
    addRoute.grantInvoke(accessRole);

    const [statusRoute] = httpApi.addRoutes({
      path: '/status',
      methods: [HttpMethod.GET],
      integration: statusIntegration,
    });
    statusRoute.grantInvoke(accessRole);

    this.httpApi = httpApi;
  }
}
