// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Sharp from 'sharp';
import { promisify } from 'util';
import dns from 'dns';

const s3Client = new S3Client();
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.transformedImageBucketName;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;
const MAX_IMAGE_SIZE = parseInt(process.env.maxImageSize);
const FETCH_TIMEOUT = parseInt(process.env.fetchTimeout) || 10000;
const MAX_FILE_SIZE = parseInt(process.env.maxFileSize) || 52428800; // 50MB

const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);

// Private IP ranges to block (SSRF protection)
const BLOCKED_IP_RANGES = [
    /^10\./,                          // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,// 172.16.0.0/12
    /^192\.168\./,                    // 192.168.0.0/16
    /^127\./,                         // 127.0.0.0/8 (loopback)
    /^169\.254\./,                    // 169.254.0.0/16 (AWS metadata)
    /^0\./,                           // 0.0.0.0/8
    /^224\./,                         // 224.0.0.0/4 (multicast)
    /^240\./,                         // 240.0.0.0/4 (reserved)
    /^::1$/,                          // IPv6 loopback
    /^::/,                            // Unspecified
    /^fe80:/i,                        // IPv6 link-local
    /^fc00:/i,                        // IPv6 unique local
    /^fd00:/i,                        // IPv6 unique local
    /^ff00:/i,                        // IPv6 multicast
];

const VALID_IMAGE_TYPES = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    'image/avif',
    'image/bmp',
    'image/tiff'
];

async function validateUrl(url) {
    const parsedUrl = new URL(url);

    // Only allow HTTP/HTTPS
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Only HTTP/HTTPS protocols allowed');
    }

    // Resolve hostname to IP and check against blocked ranges
    try {
        const ipv4Addresses = await resolve4(parsedUrl.hostname).catch(() => []);
        const ipv6Addresses = await resolve6(parsedUrl.hostname).catch(() => []);

        const allIps = [...ipv4Addresses, ...ipv6Addresses];

        for (const ip of allIps) {
            for (const range of BLOCKED_IP_RANGES) {
                if (range.test(ip)) {
                    throw new Error('Access to private IP addresses is blocked');
                }
            }
        }
    } catch (error) {
        if (error.message.includes('blocked')) throw error;
        // If DNS resolution fails, let the fetch fail naturally
    }

    return parsedUrl;
}

async function fetchExternalImage(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'AWS-Image-Optimization/1.0',
            },
            redirect: 'follow',
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Validate Content-Type
        const contentType = response.headers.get('content-type');
        if (!contentType || !VALID_IMAGE_TYPES.some(type => contentType.toLowerCase().includes(type))) {
            throw new Error(`Invalid content type: ${contentType}`);
        }

        // Check content length header
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
            throw new Error('Image file too large');
        }

        // Convert to buffer
        const arrayBuffer = await response.arrayBuffer();

        // Check actual size
        if (arrayBuffer.byteLength > MAX_FILE_SIZE) {
            throw new Error('Image file too large');
        }

        return {
            buffer: Buffer.from(arrayBuffer),
            contentType: contentType,
        };

    } catch (error) {
        clearTimeout(timeoutId);

        if (error.name === 'AbortError') {
            throw new Error('Request timeout');
        }
        throw error;
    }
}

export const handler = async (event) => {
    // Validate if this is a GET request
    if (!event.requestContext || !event.requestContext.http || !(event.requestContext.http.method === 'GET')) {
        return sendError(400, 'Only GET method is supported', event);
    }

    // Parse path: /proxy/[base64url-encoded-url]/[operations]
    // Example: /proxy/aHR0cHM6Ly9leGFtcGxlLmNvbS9waG90by5qcGc/format=webp,width=300
    var pathParts = event.requestContext.http.path.split('/').filter(p => p);

    if (pathParts.length < 2 || pathParts[0] !== 'proxy') {
        return sendError(400, 'Invalid request path format', '');
    }

    const encodedUrl = pathParts[1];
    const operationsPrefix = pathParts[2] || 'original';

    // Decode URL from base64url
    let imageUrl;
    try {
        // Convert base64url back to base64
        const base64 = encodedUrl
            .replace(/-/g, '+')
            .replace(/_/g, '/');

        imageUrl = Buffer.from(base64, 'base64').toString('utf-8');

        // Validate URL format
        if (!imageUrl.match(/^https?:\/\/.+/i)) {
            throw new Error('Invalid URL format');
        }
    } catch (error) {
        return sendError(400, 'Failed to decode URL', error);
    }

    // Validate URL and check for SSRF
    try {
        await validateUrl(imageUrl);
    } catch (error) {
        return sendError(403, 'URL validation failed: ' + error.message, error);
    }

    var startTime = performance.now();

    // Fetch original image from external URL
    let originalImageBody;
    let contentType;
    try {
        console.log(`Fetching image from: ${imageUrl}`);
        const result = await fetchExternalImage(imageUrl);
        originalImageBody = result.buffer;
        contentType = result.contentType;
        console.log(`Successfully fetched image (${originalImageBody.length} bytes)`);
    } catch (error) {
        console.log('Error fetching external image:', error.message);
        if (error.message.includes('timeout')) {
            return sendError(504, 'Request timeout while fetching image', error);
        }
        if (error.message.includes('too large')) {
            return sendError(413, 'Image file too large', error);
        }
        if (error.message.includes('content type')) {
            return sendError(415, 'Unsupported media type', error);
        }
        return sendError(502, 'Failed to fetch external image: ' + error.message, error);
    }

    let transformedImage = Sharp(originalImageBody, { failOn: 'none', animated: true });

    // Get image orientation to rotate if needed
    const imageMetadata = await transformedImage.metadata();

    // Execute the requested operations
    const operationsJSON = Object.fromEntries(operationsPrefix.split(',').map(operation => operation.split('=')));

    // Variable holding the server timing header value
    var timingLog = 'img-download;dur=' + parseInt(performance.now() - startTime);
    startTime = performance.now();

    try {
        // Check if resizing is requested
        var resizingOptions = {
            fit: 'inside',           // Preserve full image, fit within bounds
            withoutEnlargement: true, // Never upscale (prevents blurry images)
        };
        if (operationsJSON['width']) resizingOptions.width = parseInt(operationsJSON['width']);
        if (operationsJSON['height']) resizingOptions.height = parseInt(operationsJSON['height']);

        // Only resize if width or height is specified
        if (resizingOptions.width || resizingOptions.height) {
            transformedImage = transformedImage.resize(resizingOptions);
        }

        // Check if rotation is needed
        if (imageMetadata.orientation) transformedImage = transformedImage.rotate();

        // Check if formatting is requested
        if (operationsJSON['format']) {
            var isLossy = false;
            switch (operationsJSON['format']) {
                case 'jpeg': contentType = 'image/jpeg'; isLossy = true; break;
                case 'gif': contentType = 'image/gif'; break;
                case 'webp': contentType = 'image/webp'; isLossy = true; break;
                case 'png': contentType = 'image/png'; break;
                case 'avif': contentType = 'image/avif'; isLossy = true; break;
                default: contentType = 'image/jpeg'; isLossy = true;
            }
            if (operationsJSON['quality'] && isLossy) {
                transformedImage = transformedImage.toFormat(operationsJSON['format'], {
                    quality: parseInt(operationsJSON['quality']),
                });
            } else transformedImage = transformedImage.toFormat(operationsJSON['format']);
        } else {
            // If no format is specified, Sharp converts svg to png by default
            if (contentType === 'image/svg+xml') contentType = 'image/png';
        }
        transformedImage = await transformedImage.toBuffer();
    } catch (error) {
        return sendError(500, 'Error transforming image', error);
    }

    timingLog = timingLog + ',img-transform;dur=' + parseInt(performance.now() - startTime);

    // Handle gracefully generated images bigger than a specified limit
    const imageTooBig = Buffer.byteLength(transformedImage) > MAX_IMAGE_SIZE;

    // Upload transformed image back to S3 if required in the architecture
    if (S3_TRANSFORMED_IMAGE_BUCKET) {
        startTime = performance.now();
        try {
            // Cache key: base64url(url) + '/' + operations
            const cacheKey = encodedUrl + '/' + operationsPrefix;

            // Encode metadata values to be header-safe (only ASCII printable chars allowed)
            const safeUrl = Buffer.from(imageUrl).toString('base64');

            const putImageCommand = new PutObjectCommand({
                Body: transformedImage,
                Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
                Key: cacheKey,
                ContentType: contentType,
                CacheControl: TRANSFORMED_IMAGE_CACHE_TTL,
                Metadata: {
                    'original-url-base64': safeUrl,
                    'transformations': operationsPrefix,
                },
            });
            await s3Client.send(putImageCommand);
            timingLog = timingLog + ',img-upload;dur=' + parseInt(performance.now() - startTime);

            // Only redirect if image is too big, otherwise return directly
            // Subsequent requests will be served from S3 via CloudFront cache
            if (imageTooBig) {
                return {
                    statusCode: 307,
                    headers: {
                        'Location': '/proxy/' + encodedUrl + '/' + operationsPrefix,
                        'Cache-Control': 'no-store',
                        'Server-Timing': timingLog
                    }
                };
            }
        } catch (error) {
            logError('Could not upload transformed image to S3', error);
            // Fall through to return image directly if S3 upload failed
        }
    }

    // Return error if the image is too big and S3 storage was not available
    if (imageTooBig) {
        return sendError(413, 'Requested transformed image is too big', '');
    }

    // Fallback: return image directly (only if S3 caching disabled or upload failed)
    return {
        statusCode: 200,
        body: transformedImage.toString('base64'),
        isBase64Encoded: true,
        headers: {
            'Content-Type': contentType,
            'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL,
            'Server-Timing': timingLog
        }
    };
};

function sendError(statusCode, body, error) {
    logError(body, error);
    return {
        statusCode,
        body: JSON.stringify({ error: body }),
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
        }
    };
}

function logError(body, error) {
    console.log('APPLICATION ERROR', body);
    if (error) console.log(error);
}
