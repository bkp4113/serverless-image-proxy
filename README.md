## Serverless Image Optimization & Proxy

Images are usually the heaviest components of a web page, both in terms of bytes and number of HTTP requests. Optimizing images on your website is critical to improve your users' experience, reduce delivery costs and enhance your position in search engine ranking. For example, Google's Largest Contentful Paint metric in their search ranking algorithm is highly impacted by how much you optimize the images on your website. In this solution, we provide you with a simple and performant solution for image optimization using serverless components such as Amazon CloudFront and AWS Lambda.

The proposed architecture fetches images from external URLs, applies transformations on-demand, and caches the results. Image transformation is executed centrally in an AWS Region, only when the image hasn't been already transformed and cached. The available transformations include resizing and formatting, but can be extended to more operations if needed. Both transformations can be requested by the front-end, with the possibility of automatic format selection done on server side. The architecture is based on CloudFront for content delivery and Lambda for image processing. The request flow is explained below:

1. The user sends an HTTP request with the external image URL and desired transformations as query parameters. An example URL would look like this: https://YOUR-DISTRIBUTION.cloudfront.net/?url=https://example.com/photo.jpg&format=webp&width=300.
2. The request is processed by a nearby CloudFront edge location providing the best performance. Before passing the request upstream, a CloudFront Function is executed on viewer request event to rewrite the request URL. CloudFront Functions is a feature of CloudFront that allows you to write lightweight functions in JavaScript for high-scale, latency-sensitive CDN customizations. In our architecture, we rewrite the URL to validate the requested transformations, encode the external URL safely, and normalize the parameters to increase the cache hit ratio. When an automatic transformation is requested, the function also decides about the best one to apply. For example, if the user asks for the most optimized image format (JPEG, WebP, or AVIF) using the directive format=auto, CloudFront Function will select the best format based on the Accept header present in the request.
3. If the requested image is already cached in CloudFront then there will be a cache hit and the image is returned from CloudFront cache. To increase the cache hit ratio, we enable Origin Shield, a feature of CloudFront that acts as an additional layer of caching before the origin. If the image is not in CloudFront cache, the request will be forwarded to an S3 bucket for transformed images (if caching is enabled), or directly to Lambda.
4. When Lambda is invoked, it fetches the original image from the external URL, validates the source for security (SSRF protection), transforms it using Sharp library, optionally stores the transformed image in S3, then serves it through CloudFront where it will be cached for future requests.

## Image Processing with Sharp

This solution uses [Sharp](https://sharp.pixelplumbing.com/) - a high-performance Node.js module for image processing. Sharp is the ideal choice for serverless image optimization due to its exceptional speed, memory efficiency, and ease of deployment.

### Why Sharp?

* **Performance**: Sharp is 4-5x faster than ImageMagick and GraphicsMagick, powered by [libvips](https://github.com/libvips/libvips) - a battle-tested image processing library actively maintained since 1989.
* **Memory Efficient**: Processes images in small chunks rather than loading entire uncompressed images into memory, making it perfect for Lambda's memory constraints.
* **Non-blocking Architecture**: Leverages libuv for async I/O with no child processes, fully supporting Promises and async/await patterns.
* **Zero Runtime Dependencies**: Works out-of-the-box on modern systems with no additional installations required in Lambda.
* **Format Support**: Reads JPEG, PNG, WebP, GIF, AVIF, TIFF, and SVG; outputs to JPEG, PNG, WebP, GIF, AVIF, and TIFF.
* **Built-in Optimization**: Includes mozjpeg and pngquant for automatic file size reduction without external tools.

### Sharp Capabilities

Sharp provides comprehensive image manipulation capabilities including:
- **Resizing**: Width/height adjustments with multiple fit strategies (cover, contain, fill, inside, outside)
- **Format Conversion**: Seamless conversion between modern image formats (JPEG, PNG, WebP, AVIF)
- **Quality Control**: Fine-grained quality settings for lossy formats
- **Rotation & Extraction**: Image rotation and region extraction
- **Compositing**: Layer multiple images together
- **Stream Processing**: Process images from and to streams for efficient memory usage

For complete documentation and API reference, visit [sharp.pixelplumbing.com](https://sharp.pixelplumbing.com/).

## Security Features

This solution includes multiple layers of security protection:

* **SSRF Protection**: The Lambda function validates external URLs and blocks access to private IP ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, etc.) and cloud metadata services (169.254.169.254) to prevent Server-Side Request Forgery attacks.
* **Content Validation**: Only processes valid image content types (image/jpeg, image/png, image/webp, image/gif, image/avif, image/svg+xml).
* **File Size Limits**: Enforces maximum file size for external images (default 50MB) to prevent resource exhaustion.
* **Timeout Protection**: External image fetches timeout after 10 seconds (configurable) to prevent hanging requests.
* **Origin Access Control (OAC)**: CloudFront is configured with OAC to sign requests using AWS Signature Version 4 before invoking the Lambda function, preventing unauthorized access.

Note the following:

* Transformed images can optionally be stored in S3 with lifecycle policies to optimize storage costs:
  - After 30 days: Images are transitioned to Glacier Instant Retrieval (lower storage cost, same millisecond access time)
  - After 2 years (default): Images are permanently deleted
  - This significantly reduces Lambda invocations and storage costs for popular images
  - The cache key is based on the base64-encoded source URL and transformation parameters
* If you need to invalidate all cached variants of an image in CloudFront, use a CloudFront invalidation with an appropriate pattern.

## Deploy the solution using CDK

> [!NOTE]
> This solution is using [sharp](https://github.com/lovell/sharp) library for image processing. Your local development environment and the image processing Lambda function environment may be using different CPU and OS architectures - for example, when you are on an M1 Mac, trying to build code for a Linux-based, x86 Lambda runtime. If necessary, the solution will automatically perform a [cross-platform](https://sharp.pixelplumbing.com/install#cross-platform) installation of all required dependencies. **Ensure your local npm version is 10.4.0 or later**, to correctly leverage npm flags for native dependency management and take advantage of Lambda function size optimizations.

```
git clone https://github.com/aws-samples/image-optimization.git
cd image-optimization
npm install
cdk bootstrap
npm run build
cdk deploy
```

When the deployment is completed within minutes, the CDK output will include the domain name of the CloudFront distribution created for image optimization (ImageDeliveryDomain = YOURDISTRIBUTION.cloudfront.net). To verify that it is working properly, test the following optimized image URL: https://YOURDISTRIBUTION.cloudfront.net/?url=https://picsum.photos/800/600&format=auto&width=300

## Usage

### URL Format
```
https://YOUR-DISTRIBUTION.cloudfront.net/?url=<IMAGE_URL>&<TRANSFORMATIONS>
```

### Parameters
- **url** (required): The external image URL (must be HTTP or HTTPS)
- **format** (optional): Target format - `auto`, `jpeg`, `webp`, `avif`, `png`, `gif`
- **width** (optional): Target width in pixels (max 4000)
- **height** (optional): Target height in pixels (max 4000)
- **quality** (optional): Quality for lossy formats (1-100)

### Examples
```bash
# Convert to WebP, resize to 300px wide
https://YOUR-DIST.cloudfront.net/?url=https://example.com/photo.jpg&format=webp&width=300

# Auto-select best format based on browser support
https://YOUR-DIST.cloudfront.net/?url=https://example.com/photo.jpg&format=auto&width=800

# Resize and adjust quality
https://YOUR-DIST.cloudfront.net/?url=https://example.com/photo.jpg&width=400&height=300&quality=85
```

## Deployment Parameters

The stack can be deployed with the following parameters:

* **STORE_TRANSFORMED_IMAGES** - Enable caching of transformed images in S3. When disabled, every image request is sent for transformation using Lambda upon cache miss in CloudFront. Usage: `cdk deploy -c STORE_TRANSFORMED_IMAGES=false`. Default: `true`.
* **S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION** - When STORE_TRANSFORMED_IMAGES is set to true, this parameter sets the expiration time in days for stored transformed images in S3. After this expiration time, objects are deleted to save storage cost. Usage: `cdk deploy -c S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION=365`. Default: `730` days (2 years).
* **S3_TRANSFORMED_IMAGE_CACHE_TTL** - When STORE_TRANSFORMED_IMAGES is set to true, this parameter sets a Cache-Control directive on transformed images. Usage: `cdk deploy -c S3_TRANSFORMED_IMAGE_CACHE_TTL='max-age=3600'`. Default: `'max-age=31622400'` (1 year).
* **CLOUDFRONT_ORIGIN_SHIELD_REGION** - Specify the Origin Shield region. Usage: `cdk deploy -c CLOUDFRONT_ORIGIN_SHIELD_REGION=us-east-1`. Default: automatically selected based on the region of the stack.
* **CLOUDFRONT_CORS_ENABLED** - Enable/disable CORS headers. Usage: `cdk deploy -c CLOUDFRONT_CORS_ENABLED=false`. Default: `true`.
* **LAMBDA_MEMORY** - Memory in MB for the Lambda function that processes images. Usage: `cdk deploy -c LAMBDA_MEMORY=2000`. Default: `1500` MB.
* **LAMBDA_TIMEOUT** - Timeout in seconds for the Lambda function that processes images. Usage: `cdk deploy -c LAMBDA_TIMEOUT=90`. Default: `60` seconds.
* **MAX_IMAGE_SIZE** - Maximum transformed image size in bytes. If exceeded and S3 caching is enabled, Lambda redirects to S3; otherwise returns error. Usage: `cdk deploy -c MAX_IMAGE_SIZE=200000`. Default: `4700000` bytes.
* **FETCH_TIMEOUT** - Timeout in milliseconds for fetching external images. Usage: `cdk deploy -c FETCH_TIMEOUT=15000`. Default: `10000` ms (10 seconds).
* **MAX_FILE_SIZE** - Maximum external image file size in bytes. Usage: `cdk deploy -c MAX_FILE_SIZE=104857600`. Default: `52428800` bytes (50MB).

## Cost optimization
The solution includes automatic cost optimization:
* **Glacier Instant Retrieval**: Transformed images older than 30 days automatically transition to Glacier Instant Retrieval, reducing storage costs by ~68% while maintaining millisecond access times
* **Lifecycle Expiration**: Images are automatically deleted after 2 years (configurable via S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION)

Additional optimizations you can implement:
* Adjust S3 object retention period based on your access patterns
* Tune Lambda memory configuration (higher memory = faster processing but higher cost per invocation)
* Disable S3 caching (STORE_TRANSFORMED_IMAGES=false) if most images are requested only once
* Use ARM-based Lambda (Graviton2) for better price-performance

## Clean up resources

To remove cloud resources created for this solution, just execute the following command:

```
cdk destroy
```

## License

This library is licensed under the MIT-0 License. See the LICENSE file.

