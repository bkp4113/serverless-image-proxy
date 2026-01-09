// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Fn, Stack, StackProps, RemovalPolicy, Tags, aws_s3 as s3, aws_s3_deployment as s3deploy, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_lambda as lambda, aws_iam as iam, Duration, CfnOutput, aws_logs as logs } from 'aws-cdk-lib';
import { CfnDistribution } from "aws-cdk-lib/aws-cloudfront";
import { Construct } from 'constructs';
import { getOriginShieldRegion } from './origin-shield';
import { createHash } from 'crypto';
import { LogGroup } from 'aws-cdk-lib/aws-logs';

// Stack Parameters

// related to architecture. If set to false, transformed images are not stored in S3, and all image requests land on Lambda
var STORE_TRANSFORMED_IMAGES = 'true';
// CloudFront parameters
var CLOUDFRONT_ORIGIN_SHIELD_REGION = getOriginShieldRegion(process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1');
var CLOUDFRONT_CORS_ENABLED = 'true';
// Parameters of transformed images
var S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = '730'; // 2 years
var S3_TRANSFORMED_IMAGE_CACHE_TTL = 'max-age=31622400';
// Max image size in bytes. If generated images are stored on S3, bigger images are generated, stored on S3
// and request is redirect to the generated image. Otherwise, an application error is sent.
var MAX_IMAGE_SIZE = '4700000';
// Lambda Parameters
var LAMBDA_MEMORY = '1500';
var LAMBDA_TIMEOUT = '60';
// External image fetch parameters
var FETCH_TIMEOUT = '10000';
var MAX_FILE_SIZE = '52428800';

type ImageDeliveryCacheBehaviorConfig = {
  origin: any;
  compress: any;
  viewerProtocolPolicy: any;
  cachePolicy: any;
  functionAssociations: any;
  responseHeadersPolicy?: any;
};

type LambdaEnv = {
  transformedImageBucketName?: any;
  transformedImageCacheTTL: string,
  maxImageSize: string,
  fetchTimeout: string,
  maxFileSize: string,
}

export class ImageOptimizationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Add cost tracking tag for AWS AppManager
    Tags.of(this).add('AppManagerCFNStackKey', 'ImageOptimization');

    // Change stack parameters based on provided context
    STORE_TRANSFORMED_IMAGES = this.node.tryGetContext('STORE_TRANSFORMED_IMAGES') || STORE_TRANSFORMED_IMAGES;
    S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION') || S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION;
    S3_TRANSFORMED_IMAGE_CACHE_TTL = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_CACHE_TTL') || S3_TRANSFORMED_IMAGE_CACHE_TTL;
    CLOUDFRONT_ORIGIN_SHIELD_REGION = this.node.tryGetContext('CLOUDFRONT_ORIGIN_SHIELD_REGION') || CLOUDFRONT_ORIGIN_SHIELD_REGION;
    CLOUDFRONT_CORS_ENABLED = this.node.tryGetContext('CLOUDFRONT_CORS_ENABLED') || CLOUDFRONT_CORS_ENABLED;
    LAMBDA_MEMORY = this.node.tryGetContext('LAMBDA_MEMORY') || LAMBDA_MEMORY;
    LAMBDA_TIMEOUT = this.node.tryGetContext('LAMBDA_TIMEOUT') || LAMBDA_TIMEOUT;
    MAX_IMAGE_SIZE = this.node.tryGetContext('MAX_IMAGE_SIZE') || MAX_IMAGE_SIZE;
    FETCH_TIMEOUT = this.node.tryGetContext('FETCH_TIMEOUT') || FETCH_TIMEOUT;
    MAX_FILE_SIZE = this.node.tryGetContext('MAX_FILE_SIZE') || MAX_FILE_SIZE;

    var transformedImageBucket;

    // create bucket for transformed images if enabled in the architecture
    if (STORE_TRANSFORMED_IMAGES === 'true') {
      transformedImageBucket = new s3.Bucket(this, 's3-transformed-image-bucket', {
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        lifecycleRules: [
          {
            transitions: [
              {
                storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
                transitionAfter: Duration.days(30),
              },
            ],
            expiration: Duration.days(parseInt(S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION)),
          },
        ],
      });
    }

    // prepare env variable for Lambda
    var lambdaEnv: LambdaEnv = {
      transformedImageCacheTTL: S3_TRANSFORMED_IMAGE_CACHE_TTL,
      maxImageSize: MAX_IMAGE_SIZE,
      fetchTimeout: FETCH_TIMEOUT,
      maxFileSize: MAX_FILE_SIZE,
    };
    if (transformedImageBucket) lambdaEnv.transformedImageBucketName = transformedImageBucket.bucketName;

    // statements of the IAM policy to attach to Lambda
    var iamPolicyStatements: iam.PolicyStatement[] = [];

    // Create Lambda for image processing
    var lambdaProps = {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/image-processing'),
      timeout: Duration.seconds(parseInt(LAMBDA_TIMEOUT)),
      memorySize: parseInt(LAMBDA_MEMORY),
      environment: lambdaEnv,
      logGroup: new logs.LogGroup(this, 'MyFunctionLogGroup', {
          retention: logs.RetentionDays.ONE_DAY,
        })
    };
    var imageProcessing = new lambda.Function(this, 'image-optimization', lambdaProps);

    // Enable Lambda URL
    const imageProcessingURL = imageProcessing.addFunctionUrl();

    // Leverage CDK Intrinsics to get the hostname of the Lambda URL 
    const imageProcessingDomainName = Fn.parseDomainName(imageProcessingURL.url);

    // Create a CloudFront origin: S3 with fallback to Lambda when image needs to be transformed, otherwise with Lambda as sole origin
    var imageOrigin;

    if (transformedImageBucket) {
      imageOrigin = new origins.OriginGroup({
        primaryOrigin: origins.S3BucketOrigin.withOriginAccessControl(transformedImageBucket, {
          originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
        }),
        fallbackOrigin: new origins.HttpOrigin(imageProcessingDomainName, {
          originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
        }),
        fallbackStatusCodes: [403, 500, 503, 504],
      });

      // write policy for Lambda on the s3 bucket for transformed images
      var s3WriteTransformedImagesPolicy = new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: ['arn:aws:s3:::' + transformedImageBucket.bucketName + '/*'],
      });
      iamPolicyStatements.push(s3WriteTransformedImagesPolicy);
    } else {
      imageOrigin = new origins.HttpOrigin(imageProcessingDomainName, {
        originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
      });
    }

    // attach iam policy to the role assumed by Lambda
    imageProcessing.role?.attachInlinePolicy(
      new iam.Policy(this, 'read-write-bucket-policy', {
        statements: iamPolicyStatements,
      }),
    );

    // Create a CloudFront Function for url rewrites
    const urlRewriteFunction = new cloudfront.Function(this, 'urlRewrite', {
      code: cloudfront.FunctionCode.fromFile({ filePath: 'functions/url-rewrite/index.js', }),
      functionName: `urlRewriteFunction${this.node.addr}`,
      // Using default runtime (ES5.1) for maximum compatibility
    });

    var imageDeliveryCacheBehaviorConfig: ImageDeliveryCacheBehaviorConfig = {
      origin: imageOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      compress: true,
      cachePolicy: new cloudfront.CachePolicy(this, `ImageCachePolicy${this.node.addr}`, {
        defaultTtl: Duration.hours(24),
        maxTtl: Duration.days(365),
        minTtl: Duration.seconds(0)
      }),
      functionAssociations: [{
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: urlRewriteFunction,
      }],
    }

    if (CLOUDFRONT_CORS_ENABLED === 'true') {
      // Creating a custom response headers policy. CORS allowed for all origins.
      const imageResponseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, `ResponseHeadersPolicy${this.node.addr}`, {
        responseHeadersPolicyName: `ImageResponsePolicy${this.node.addr}`,
        corsBehavior: {
          accessControlAllowCredentials: false,
          accessControlAllowHeaders: ['*'],
          accessControlAllowMethods: ['GET'],
          accessControlAllowOrigins: ['*'],
          accessControlMaxAge: Duration.seconds(600),
          originOverride: false,
        },
        // recognizing image requests that were processed by this solution
        customHeadersBehavior: {
          customHeaders: [
            { header: 'x-aws-image-optimization', value: 'v1.0', override: true },
            { header: 'vary', value: 'accept', override: true },
          ],
        }
      });
      imageDeliveryCacheBehaviorConfig.responseHeadersPolicy = imageResponseHeadersPolicy;
    }
    const imageDelivery = new cloudfront.Distribution(this, 'imageDeliveryDistribution', {
      comment: 'image optimization - image delivery',
      defaultBehavior: imageDeliveryCacheBehaviorConfig
    });

    // ADD OAC between CloudFront and LambdaURL
    const oac = new cloudfront.CfnOriginAccessControl(this, "OAC", {
      originAccessControlConfig: {
        name: `oac${this.node.addr}`, 
        originAccessControlOriginType: "lambda",
        signingBehavior: "always",
        signingProtocol: "sigv4",
      },
    });

    const cfnImageDelivery = imageDelivery.node.defaultChild as CfnDistribution;
    cfnImageDelivery.addPropertyOverride(`DistributionConfig.Origins.${(STORE_TRANSFORMED_IMAGES === 'true')?"1":"0"}.OriginAccessControlId`, oac.getAtt("Id"));

    imageProcessing.addPermission("AllowCloudFrontServicePrincipal", {
      principal: new iam.ServicePrincipal("cloudfront.amazonaws.com"),
      action: "lambda:InvokeFunctionUrl",
      sourceArn: `arn:aws:cloudfront::${this.account}:distribution/${imageDelivery.distributionId}`
    })

    new CfnOutput(this, 'ImageDeliveryDomain', {
      description: 'Domain name of image delivery',
      value: imageDelivery.distributionDomainName
    });
  }
}
